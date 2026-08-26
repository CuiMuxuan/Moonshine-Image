import { computed, ref } from "vue";
import { defineStore } from "pinia";

export const DEFAULT_APP_UPDATE_STATE = Object.freeze({
  enabled: false,
  channel: "stable",
  status: "disabled",
  currentVersion: "",
  currentVersionUpdatedAt: null,
  availableVersion: null,
  latestVersion: null,
  releaseName: null,
  releaseDate: null,
  releaseNotes: null,
  progress: 0,
  bytesPerSecond: 0,
  transferred: 0,
  total: 0,
  checkedAt: null,
  downloadedAt: null,
  error: null,
  retryAction: null,
  installBlockedReason: null,
});

export const DEFAULT_EXTERNAL_ENVIRONMENT_STATE = Object.freeze({
  status: "unselected",
  candidateId: null,
  selectedPath: "",
  layout: null,
  accelerator: null,
  diagnostics: null,
  canActivate: false,
  probedAt: null,
  error: null,
});

export const DEFAULT_ENVIRONMENT_UPDATE_STATE = Object.freeze({
  usable: false,
  source: "managed",
  status: "idle",
  checkedAt: null,
  currentAccelerator: null,
  pythonVersion: null,
  torchVersion: null,
  torchPackage: null,
  cudaVersion: null,
  cudaAvailable: null,
  gpuName: null,
  nvidiaDeviceName: null,
  nvidiaDriverVersion: null,
  canSwitchToCu130: false,
  canSwitchToCpu: false,
  acceleratorChangeReason: null,
  reason: null,
  requiredAction: null,
  error: null,
});

export const DEFAULT_RUNTIME_UPDATE_STATE = Object.freeze({
  enabled: false,
  status: "disabled",
  source: "managed",
  external: { ...DEFAULT_EXTERNAL_ENVIRONMENT_STATE },
  preference: "auto",
  preferenceExplicit: false,
  selectedAccelerator: null,
  detectedAccelerator: null,
  specHash: null,
  pythonVersion: null,
  torchVersion: null,
  cudaVersion: null,
  ffmpegVersion: null,
  ffmpegPath: null,
  activePath: null,
  targetPath: null,
  videoAvailable: null,
  operationId: null,
  canCancel: false,
  canRollback: false,
  checkedAt: null,
  updatedAt: null,
  progress: null,
  restartRequired: false,
  error: null,
  nvidiaDeviceName: null,
  nvidiaDriverVersion: null,
  canSwitchToCu130: false,
  canSwitchToCpu: false,
  acceleratorChangeReason: null,
  environmentUpdate: { ...DEFAULT_ENVIRONMENT_UPDATE_STATE },
});

const UPDATE_ACTIONS = Object.freeze({
  CHECK: "check",
  DOWNLOAD: "download",
  INSTALL: "install",
});

const normalizeRetryAction = (value) => {
  const action = String(value || "").toLowerCase();
  return Object.values(UPDATE_ACTIONS).includes(action) ? action : null;
};

const resolveRetryAction = (updateState = {}) =>
  normalizeRetryAction(
    updateState.retryAction ||
      updateState.error?.retryAction ||
      updateState.error?.phase
  );

const getElectronApi = () =>
  typeof window === "undefined" ? null : window.electron?.ipcRenderer || null;

export const normalizeRuntimeAccelerator = (value) => {
  const accelerator = String(value || "").trim().toLowerCase();
  return ["auto", "cpu", "cu130"].includes(accelerator) ? accelerator : "auto";
};

export const useUpdateManagerStore = defineStore("updateManager", () => {
  const state = ref({ ...DEFAULT_APP_UPDATE_STATE });
  const runtimeState = ref({ ...DEFAULT_RUNTIME_UPDATE_STATE });
  const initialized = ref(false);
  const pendingAction = ref(null);
  const pendingRuntimeAction = ref(null);
  const runtimeCancellationPending = ref(false);
  const pendingExternalAction = ref(null);
  let unsubscribe = null;
  let unsubscribeRuntime = null;

  const applyState = (nextState = {}) => {
    if (!nextState || typeof nextState !== "object") return state.value;
    state.value = { ...state.value, ...nextState };
    return state.value;
  };

  const applyRuntimeState = (nextState = {}) => {
    if (!nextState || typeof nextState !== "object") return runtimeState.value;
    // Runtime channel/component fields are intentionally ignored. The runtime
    // IPC names remain compatible, but the state now represents local envs.
    const environmentState = { ...nextState };
    ["channel", "manifestSequence", "availableComponents", "activeComponents", "lastSourceId"].forEach(
      (key) => delete environmentState[key]
    );
    const preference = normalizeRuntimeAccelerator(
      environmentState.preference ?? runtimeState.value.preference ?? "auto"
    );
    const selectedValue = Object.hasOwn(environmentState, "selectedAccelerator")
      ? environmentState.selectedAccelerator
      : Object.hasOwn(environmentState, "accelerator")
        ? environmentState.accelerator
        : runtimeState.value.selectedAccelerator;
    const selectedAccelerator = ["cpu", "cu130"].includes(String(selectedValue || "").toLowerCase())
      ? String(selectedValue).toLowerCase()
      : null;
    const externalState = {
      ...(environmentState.external || environmentState.externalEnvironment || {}),
    };
    if (Object.hasOwn(environmentState, "externalPath")) {
      externalState.selectedPath = environmentState.externalPath || "";
    }
    if (Object.hasOwn(environmentState, "externalLayout")) {
      externalState.layout = environmentState.externalLayout || null;
    }
    if (Object.hasOwn(environmentState, "externalLastVerifiedAt")) {
      externalState.probedAt = environmentState.externalLastVerifiedAt || null;
    }
    if (environmentState.source === "external" && environmentState.externalConfigured) {
      externalState.status = "active";
      externalState.diagnostics = environmentState.diagnostics || externalState.diagnostics || null;
      externalState.accelerator = environmentState.selectedAccelerator || null;
    } else if (
      environmentState.source === "managed" &&
      environmentState.externalConfigured === false &&
      !environmentState.externalPath
    ) {
      externalState.status = "unselected";
    }
    delete environmentState.externalEnvironment;
    // Core candidate tokens/fingerprints are main-process details. The renderer
    // uses only the opaque candidateId exposed in state.external.
    delete environmentState.externalCandidateToken;
    delete environmentState.externalCandidateExpiresAt;
    delete environmentState.externalFingerprint;
    runtimeState.value = {
      ...runtimeState.value,
      ...environmentState,
      preference,
      selectedAccelerator,
      source: ["managed", "external"].includes(environmentState.source)
        ? environmentState.source
        : runtimeState.value.source,
      external: Object.keys(externalState).length
        ? { ...runtimeState.value.external, ...externalState }
        : runtimeState.value.external,
    };
    return runtimeState.value;
  };

  const applyEnvironmentUpdateResult = (result = {}) => {
    if (!result || typeof result !== "object") return runtimeState.value.environmentUpdate;
    const status = result.updateStatus && typeof result.updateStatus === "object"
      ? result.updateStatus
      : result.status && typeof result.status === "object"
        ? result.status
        : result;
    const currentAccelerator = status.currentAccelerator || status.selectedAccelerator || null;
    const gpuName = status.nvidiaDeviceName || status.gpu?.model || null;
    const nvidiaDriverVersion = status.nvidiaDriverVersion || status.gpu?.driverVersion || null;
    const torchVersion = status.torch?.version || status.torchVersion || null;
    const cudaVersion = status.torch?.cudaVersion ?? status.cudaVersion ?? null;
    const cudaAvailable = status.torch?.cudaAvailable ?? status.cudaAvailable ?? null;
    const usable = status.available === true && status.success !== false;
    const environmentUpdate = {
      ...runtimeState.value.environmentUpdate,
      usable,
      source: status.source || runtimeState.value.source,
      status: status.status || runtimeState.value.status,
      checkedAt: status.checkedAt || (usable ? new Date().toISOString() : runtimeState.value.environmentUpdate.checkedAt) || null,
      currentAccelerator,
      pythonVersion: status.python?.version || status.pythonVersion || null,
      torchVersion,
      torchPackage: currentAccelerator === "cu130" ? "cuda" : currentAccelerator === "cpu" ? "cpu" : null,
      cudaVersion,
      cudaAvailable,
      gpuName,
      nvidiaDeviceName: gpuName,
      nvidiaDriverVersion,
      canSwitchToCu130: Boolean(status.canSwitchToCu130),
      canSwitchToCpu: Boolean(status.canSwitchToCpu),
      acceleratorChangeReason: status.acceleratorChangeReason || null,
      reason: status.reason || null,
      requiredAction: status.requiredAction || null,
      error: status.success === false
        ? { message: String(status.error?.message || status.error || status.reason || "运行环境更新检测失败。"), code: status.code || null }
        : null,
    };
    applyRuntimeState({
      nvidiaDeviceName: environmentUpdate.nvidiaDeviceName,
      nvidiaDriverVersion: environmentUpdate.nvidiaDriverVersion,
      canSwitchToCu130: environmentUpdate.canSwitchToCu130,
      canSwitchToCpu: environmentUpdate.canSwitchToCpu,
      acceleratorChangeReason: environmentUpdate.acceleratorChangeReason,
      environmentUpdate,
    });
    return runtimeState.value.environmentUpdate;
  };

  const applyFailure = (error, fallbackRetryAction = null) => {
    const normalized = error?.error || error;
    const retryAction =
      resolveRetryAction(error?.state || error) ||
      normalizeRetryAction(fallbackRetryAction);
    applyState({
      status: "error",
      error: {
        message: String(normalized?.message || normalized || "应用更新请求失败。"),
        code: normalized?.code ? String(normalized.code) : null,
        phase: retryAction,
        retryAction,
      },
      retryAction,
    });
  };

  const initialize = async () => {
    if (initialized.value) return state.value;
    initialized.value = true;
    const api = getElectronApi();
    if (!api) return state.value;

    try {
      const initial = api.getAppUpdateState
        ? await api.getAppUpdateState()
        : await api.invoke?.("app-update-get-state");
      applyState(initial);
    } catch (error) {
      applyFailure(error, UPDATE_ACTIONS.CHECK);
    }

    try {
      const runtimeInitial = api.getRuntimeState
        ? await api.getRuntimeState()
        : await api.invoke?.("runtime-get-state");
      applyRuntimeState(runtimeInitial);
    } catch (error) {
      applyRuntimeState({
        status: "failed",
        error: { message: String(error?.message || error || "运行环境状态读取失败。"), code: "RUNTIME_STATE_FAILED" },
      });
    }

    const listener = api.onAppUpdateState
      ? api.onAppUpdateState((nextState) => {
        applyState(nextState);
      })
      : api.on?.("app-update-state", (_event, nextState) => {
        applyState(nextState);
      });
    unsubscribe = typeof listener === "function" ? listener : null;
    const runtimeListener = api.onRuntimeState
      ? api.onRuntimeState((nextState) => {
        applyRuntimeState(nextState);
      })
      : api.on?.("runtime-state", (_event, nextState) => {
        applyRuntimeState(nextState);
      });
    unsubscribeRuntime = typeof runtimeListener === "function" ? runtimeListener : null;
    return state.value;
  };

  const dispose = () => {
    unsubscribe?.();
    unsubscribe = null;
    unsubscribeRuntime?.();
    unsubscribeRuntime = null;
    initialized.value = false;
    pendingAction.value = null;
    pendingRuntimeAction.value = null;
    pendingExternalAction.value = null;
  };

  const invokeUpdateAction = async (action, methodName, channelName) => {
    const api = getElectronApi();
    if (!api) {
      applyFailure(new Error("当前环境不支持应用更新。"), action);
      return { success: false, code: "APP_UPDATE_UNAVAILABLE", state: state.value };
    }
    if (pendingAction.value) {
      return {
        success: false,
        code: "APP_UPDATE_ACTION_IN_PROGRESS",
        reason: "另一项更新操作正在进行，请稍候。",
        state: state.value,
      };
    }

    pendingAction.value = action;
    try {
      const result = api[methodName]
        ? await api[methodName]()
        : await api.invoke?.(channelName);
      if (result?.state) applyState(result.state);
      if (result?.success === false && result.error && !result?.state?.error) {
        applyFailure(result, action);
      }
      return result;
    } catch (error) {
      applyFailure(error, action);
      return { success: false, code: "APP_UPDATE_REQUEST_FAILED", error, state: state.value };
    } finally {
      pendingAction.value = null;
    }
  };

  const checkForUpdates = () =>
    invokeUpdateAction(UPDATE_ACTIONS.CHECK, "checkForAppUpdate", "app-update-check");
  const setAppUpdateChannel = async (channel) => {
    const api = getElectronApi();
    if (!api) {
      return { success: false, code: "APP_UPDATE_UNAVAILABLE", state: state.value };
    }
    if (pendingAction.value) {
      return { success: false, code: "APP_UPDATE_ACTION_IN_PROGRESS", state: state.value };
    }
    pendingAction.value = "channel";
    try {
      const result = api.setAppUpdateChannel
        ? await api.setAppUpdateChannel(channel)
        : await api.invoke?.("app-update-set-channel", channel);
      if (result?.state) applyState(result.state);
      if (result?.success === false) applyFailure(result, UPDATE_ACTIONS.CHECK);
      return result;
    } catch (error) {
      applyFailure(error, UPDATE_ACTIONS.CHECK);
      return { success: false, code: "APP_UPDATE_CHANNEL_SET_FAILED", error, state: state.value };
    } finally {
      pendingAction.value = null;
    }
  };
  const downloadUpdate = () =>
    invokeUpdateAction(UPDATE_ACTIONS.DOWNLOAD, "downloadAppUpdate", "app-update-download");
  const installUpdate = () =>
    invokeUpdateAction(UPDATE_ACTIONS.INSTALL, "installAppUpdate", "app-update-install");

  const invokeRuntimeAction = async (action, methodName, channelName, options = {}) => {
    const api = getElectronApi();
    if (!api) {
      applyRuntimeState({ status: "failed", error: { message: "当前环境不支持运行环境管理。", code: "RUNTIME_UNAVAILABLE" } });
      return { success: false, code: "RUNTIME_UNAVAILABLE", state: runtimeState.value };
    }
    if (pendingRuntimeAction.value) {
      return { success: false, code: "RUNTIME_ACTION_IN_PROGRESS", state: runtimeState.value };
    }
    pendingRuntimeAction.value = action;
    try {
      const result = api[methodName]
        ? await api[methodName](options)
        : await api.invoke?.(channelName, options);
      if (result?.state) applyRuntimeState(result.state);
      if (result?.success === false && result.error && !result?.state?.error) {
        applyRuntimeState({ status: "failed", error: { message: String(result.error?.message || result.error), code: result.code || null } });
      }
      return result;
    } catch (error) {
      const normalized = { message: String(error?.message || error || "运行环境操作失败。"), code: error?.code || null };
      applyRuntimeState({ status: "failed", error: normalized });
      return { success: false, code: "RUNTIME_REQUEST_FAILED", error: normalized, state: runtimeState.value };
    } finally {
      pendingRuntimeAction.value = null;
    }
  };

  const applyExternalEnvironmentResult = (result = {}, action = "") => {
    if (!result || typeof result !== "object") return runtimeState.value.external;
    if (result.state) applyRuntimeState(result.state);

    const returnedExternal =
      result.external || result.externalEnvironment || result.environment || result.candidate || null;
    const patch = {};
    if (returnedExternal && typeof returnedExternal === "object") {
      patch.status = returnedExternal.status;
      patch.candidateId = returnedExternal.candidateId;
      patch.selectedPath = returnedExternal.selectedPath || returnedExternal.normalizedPath;
      patch.layout = returnedExternal.layout;
      patch.accelerator = returnedExternal.accelerator;
      patch.diagnostics = returnedExternal.diagnostics;
      patch.canActivate = returnedExternal.canActivate;
      patch.probedAt = returnedExternal.probedAt || returnedExternal.lastVerifiedAt;
      patch.error = returnedExternal.error;
      Object.keys(patch).forEach((key) => {
        if (patch[key] === undefined) delete patch[key];
      });
    }
    const candidateId = result.candidateId || patch.candidateId;
    if (candidateId) {
      patch.candidateId = candidateId;
      patch.canActivate = true;
    }
    if (!patch.selectedPath) {
      patch.selectedPath =
        result.selectedPath ||
        result.path ||
        result.directoryPath ||
        result.directory ||
        patch.normalizedPath ||
        "";
    }
    if (!patch.layout && result.layout) patch.layout = result.layout;
    if (!patch.accelerator && result.environment?.accelerator) {
      patch.accelerator = result.environment.accelerator;
    }
    if (!patch.diagnostics && result.diagnostics) patch.diagnostics = result.diagnostics;
    if (patch.canActivate === undefined && result.canActivate !== undefined) {
      patch.canActivate = Boolean(result.canActivate);
    }
    if (!patch.status && result.success !== false) {
      if (action === "select") patch.status = "stale";
      if (action === "probe") patch.status = result.valid === false ? "invalid" : "valid";
      if (action === "activate") patch.status = "active";
      if (action === "forget") patch.status = "unselected";
    }
    if (action === "activate" && result.success !== false) {
      applyRuntimeState({ source: "external" });
    }
    if (action === "forget" && result.success !== false) {
      applyRuntimeState({ source: "managed", external: { ...DEFAULT_EXTERNAL_ENVIRONMENT_STATE } });
      return runtimeState.value.external;
    }
    if (Object.keys(patch).length) {
      applyRuntimeState({ external: patch });
    }
    return runtimeState.value.external;
  };

  const invokeExternalEnvironmentAction = async (
    action,
    methodName,
    channelName,
    payload
  ) => {
    const api = getElectronApi();
    if (!api) {
      const error = { message: "当前环境不支持选择已有 Python 环境。", code: "EXTERNAL_ENV_UNAVAILABLE" };
      applyRuntimeState({ external: { status: "invalid", error, canActivate: false } });
      return { success: false, code: error.code, error, state: runtimeState.value };
    }
    if (pendingExternalAction.value) {
      return { success: false, code: "EXTERNAL_ENV_ACTION_IN_PROGRESS", state: runtimeState.value };
    }

    pendingExternalAction.value = action;
    if (action === "probe") {
      applyRuntimeState({ external: { status: "probing", error: null, canActivate: false } });
    }
    try {
      const result = api[methodName]
        ? await api[methodName](payload)
        : await api.invoke?.(channelName, payload);
      if (result?.cancelled || result?.canceled) return result;
      applyExternalEnvironmentResult(result, action);
      if (result?.success === false) {
        const normalized = result.error && typeof result.error === "object"
          ? result.error
          : {
            message: String(result?.message || result?.reason || result?.error || "已有环境操作失败。"),
            code: result?.code || null,
          };
        applyRuntimeState({
          external: {
            status: action === "probe" ? "invalid" : runtimeState.value.external.status,
            error: normalized,
            canActivate: false,
          },
        });
      }
      return result;
    } catch (error) {
      const normalized = {
        message: String(error?.message || error || "已有环境操作失败。"),
        code: error?.code || "EXTERNAL_ENV_REQUEST_FAILED",
      };
      applyRuntimeState({
        external: {
          status: action === "probe" ? "invalid" : runtimeState.value.external.status,
          error: normalized,
          canActivate: false,
        },
      });
      return { success: false, code: normalized.code, error: normalized, state: runtimeState.value };
    } finally {
      pendingExternalAction.value = null;
    }
  };

  const checkRuntime = (options = {}) => invokeRuntimeAction("check", "checkRuntime", "runtime-check", options);
  const ensureRuntime = (options = {}) => invokeRuntimeAction("ensure", "ensureRuntime", "runtime-ensure", options);
  const rollbackRuntime = (options = {}) =>
    invokeRuntimeAction("rollback", "rollbackRuntime", "runtime-rollback", options);
  const invokeEnvironmentUpdateAction = async (action, methodName, channelName, payload = {}) => {
    const api = getElectronApi();
    if (!api) {
      const result = {
        success: false,
        available: false,
        code: "ENVIRONMENT_UPDATE_UNAVAILABLE",
        reason: "当前环境不支持运行环境更新检测。",
      };
      applyEnvironmentUpdateResult(result);
      return result;
    }
    if (pendingRuntimeAction.value) {
      return {
        success: false,
        allowed: false,
        code: "RUNTIME_ACTION_IN_PROGRESS",
        reason: "另一项运行环境操作正在进行，请稍候。",
        state: runtimeState.value,
      };
    }
    pendingRuntimeAction.value = action;
    try {
      const result = api[methodName]
        ? await api[methodName](payload)
        : await api.invoke?.(channelName, payload);
      if (result?.state) applyRuntimeState(result.state);
      applyEnvironmentUpdateResult(result);
      return result;
    } catch (error) {
      const result = {
        success: false,
        available: false,
        code: "ENVIRONMENT_UPDATE_REQUEST_FAILED",
        reason: String(error?.message || error || "运行环境更新检测失败。"),
      };
      applyEnvironmentUpdateResult(result);
      return result;
    } finally {
      pendingRuntimeAction.value = null;
    }
  };
  const checkEnvironmentUpdate = () =>
    invokeEnvironmentUpdateAction(
      "environment-update-check",
      "getEnvironmentUpdateStatus",
      "environment-update-status",
    );
  const getEnvironmentSwitchPlan = (target) =>
    invokeEnvironmentUpdateAction(
      "environment-update-plan",
      "getEnvironmentUpdatePlan",
      "environment-update-plan",
      { target },
    );
  const switchEnvironmentAccelerator = ({ target, confirmed = false } = {}) =>
    invokeEnvironmentUpdateAction(
      "environment-update-switch",
      "switchEnvironment",
      "environment-update-switch",
      { target, confirmed },
    );
  const cancelEnvironmentPreparation = async () => {
    const api = getElectronApi();
    if (!api) return { success: false, code: "RUNTIME_UNAVAILABLE", state: runtimeState.value };
    if (runtimeCancellationPending.value) {
      return { success: false, code: "ENVIRONMENT_CANCELLATION_IN_PROGRESS", state: runtimeState.value };
    }
    runtimeCancellationPending.value = true;
    try {
      const result = api.cancelEnvironmentPreparation
        ? await api.cancelEnvironmentPreparation()
        : api.cancelRuntime
          ? await api.cancelRuntime()
          : await api.invoke?.("environment-cancel");
      if (result?.state) applyRuntimeState(result.state);
      return result;
    } catch (error) {
      const normalized = { message: String(error?.message || error || "取消运行环境准备失败。"), code: error?.code || null };
      return { success: false, code: "ENVIRONMENT_CANCEL_REQUEST_FAILED", error: normalized, state: runtimeState.value };
    } finally {
      runtimeCancellationPending.value = false;
    }
  };
  const selectExternalEnvironmentDirectory = () =>
    invokeExternalEnvironmentAction(
      "select",
      "selectExternalEnvironmentDirectory",
      "environment-external-select-directory"
    );
  const probeExternalEnvironment = (options = {}) =>
    invokeExternalEnvironmentAction(
      "probe",
      "probeExternalEnvironment",
      "environment-external-probe",
      {
        candidateId:
          options.candidateId ||
          runtimeState.value.external.candidateId,
      }
    );
  const activateExternalEnvironment = (options = {}) =>
    invokeExternalEnvironmentAction(
      "activate",
      "activateExternalEnvironment",
      "environment-external-activate",
      {
        candidateId:
          options.candidateId ||
          runtimeState.value.external.candidateId,
      }
    );
  const forgetExternalEnvironment = () =>
    invokeExternalEnvironmentAction(
      "forget",
      "forgetExternalEnvironment",
      "environment-external-forget"
    );
  const returnToManagedEnvironment = () => forgetExternalEnvironment();
  const restartApplication = async () => {
    const api = getElectronApi();
    if (!api) {
      return { success: false, code: "APP_RESTART_UNAVAILABLE", reason: "当前环境不支持重启应用。" };
    }
    if (pendingRuntimeAction.value) {
      return { success: false, code: "RUNTIME_ACTION_IN_PROGRESS", reason: "运行环境操作尚未完成。" };
    }
    pendingRuntimeAction.value = "restart";
    try {
      return api.restartApplication
        ? await api.restartApplication()
        : await api.invoke?.("app-restart");
    } catch (error) {
      return {
        success: false,
        code: "APP_RESTART_FAILED",
        reason: String(error?.message || error || "重启应用失败。"),
      };
    } finally {
      pendingRuntimeAction.value = null;
    }
  };
  // Kept for preload compatibility. The old channel IPC is now interpreted as
  // an environment accelerator preference by the main process.
  const setRuntimeChannel = (accelerator) => {
    const value = normalizeRuntimeAccelerator(
      typeof accelerator === "object" ? accelerator.accelerator : accelerator
    );
    return invokeRuntimeAction("accelerator", "setRuntimeChannel", "runtime-set-channel", {
      accelerator: value,
    });
  };

  const statusLabel = computed(() => {
    const labels = {
      disabled: "不可用",
      idle: "尚未检查",
      checking: "正在检查",
      "up-to-date": "已是最新",
      available: "有可用更新",
      downloading: "正在下载",
      downloaded: "已下载，等待安装",
      installing: "正在安装",
      error: {
        check: "检查失败",
        download: "下载失败",
        install: "安装失败",
      }[resolveRetryAction(state.value)] || "更新失败",
    };
    return labels[state.value.status] || state.value.status || "未知";
  });
  const isChecking = computed(() => state.value.status === "checking");
  const isDownloading = computed(() => state.value.status === "downloading");
  const isInstalling = computed(() => state.value.status === "installing");
  const retryAction = computed(() => resolveRetryAction(state.value));
  const isActionPending = computed(() => Boolean(pendingAction.value));
  const isRuntimeActionPending = computed(() => Boolean(pendingRuntimeAction.value));
  const isExternalEnvironmentActionPending = computed(() => Boolean(pendingExternalAction.value));
  const runtimeStatusLabel = computed(() => ({
    disabled: "未启用",
    idle: "尚未创建",
    checking: "正在检查",
    preparing: "正在创建",
    creating: "正在创建",
    repairing: "正在修复",
    ready: "环境就绪",
    degraded: "环境可用，视频受限",
    cancelling: "正在取消",
    "needs-create": "需要创建",
    "needs-repair": "需要修复",
    // Compatibility aliases for older main-process states.
    "needs-download": "需要创建",
    downloading: "正在创建",
    verifying: "正在校验环境",
    "rolling-back": "正在回滚环境",
    failed: "环境失败",
  }[runtimeState.value.status] || runtimeState.value.status || "未知"));
  const runtimeCanCheck = computed(() =>
    runtimeState.value.enabled &&
    !isRuntimeActionPending.value &&
    !["checking", "preparing", "creating", "repairing", "downloading", "verifying", "rolling-back", "cancelling"].includes(runtimeState.value.status)
  );
  const runtimeCanEnsure = computed(() =>
    runtimeState.value.enabled &&
    !isRuntimeActionPending.value &&
    !["checking", "preparing", "creating", "repairing", "downloading", "verifying", "rolling-back", "cancelling"].includes(runtimeState.value.status)
  );
  const runtimeCanRollback = computed(() =>
    runtimeState.value.enabled &&
    !isRuntimeActionPending.value &&
    (runtimeState.value.canRollback === true || ["ready", "degraded"].includes(runtimeState.value.status))
  );
  const runtimeCanCancel = computed(() =>
    runtimeState.value.enabled &&
    runtimeState.value.canCancel === true &&
    !runtimeCancellationPending.value
  );
  const runtimeCanRestart = computed(() =>
    runtimeState.value.enabled &&
    runtimeState.value.restartRequired === true &&
    !isRuntimeActionPending.value
  );
  const canCheck = computed(
    () =>
      state.value.enabled &&
      !isActionPending.value &&
      (["idle", "up-to-date"].includes(state.value.status) ||
        (state.value.status === "error" && retryAction.value === UPDATE_ACTIONS.CHECK))
  );
  const canDownload = computed(
    () =>
      state.value.enabled &&
      !isActionPending.value &&
      (state.value.status === "available" ||
        (state.value.status === "error" && retryAction.value === UPDATE_ACTIONS.DOWNLOAD))
  );
  const canInstall = computed(
    () =>
      state.value.enabled &&
      !isActionPending.value &&
      (state.value.status === "downloaded" ||
        (state.value.status === "error" && retryAction.value === UPDATE_ACTIONS.INSTALL))
  );

  return {
    state,
    runtimeState,
    initialized,
    statusLabel,
    isChecking,
    isDownloading,
    isInstalling,
    retryAction,
    pendingAction,
    isActionPending,
    pendingRuntimeAction,
    isRuntimeActionPending,
    runtimeCancellationPending,
    pendingExternalAction,
    isExternalEnvironmentActionPending,
    runtimeStatusLabel,
    runtimeCanCheck,
    runtimeCanEnsure,
    runtimeCanRollback,
    runtimeCanCancel,
    runtimeCanRestart,
    canCheck,
    canDownload,
    canInstall,
    initialize,
    dispose,
    applyState,
    checkForUpdates,
    setAppUpdateChannel,
    downloadUpdate,
    installUpdate,
    applyRuntimeState,
    applyEnvironmentUpdateResult,
    checkRuntime,
    ensureRuntime,
    rollbackRuntime,
    checkEnvironmentUpdate,
    getEnvironmentSwitchPlan,
    switchEnvironmentAccelerator,
    cancelEnvironmentPreparation,
    selectExternalEnvironmentDirectory,
    probeExternalEnvironment,
    activateExternalEnvironment,
    forgetExternalEnvironment,
    returnToManagedEnvironment,
    restartApplication,
    setRuntimeChannel,
  };
});
