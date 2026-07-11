import { defineStore } from "pinia";
import { computed, ref } from "vue";

const SERVICE_STATES = new Set([
  "starting",
  "running",
  "stopping",
  "stopped",
  "failed",
]);

const PHASE_LABELS = Object.freeze({
  idle: "正在准备 Moonshine AI 引擎",
  preparing: "正在准备 Moonshine AI 引擎",
  checkingRuntime: "正在检测运行时",
  loadingModel: "正在加载模型",
  startingEngine: "正在启动 AI 引擎",
  verifying: "正在确认可用性",
  running: "Moonshine AI 引擎已就绪",
  stopping: "正在停止 Moonshine AI 引擎",
  stopped: "Moonshine AI 引擎未启动",
  failed: "Moonshine AI 引擎准备失败",
});

const getErrorMessage = (value, fallback = "") => {
  if (typeof value === "string") return value;
  return (
    value?.error ||
    value?.message ||
    value?.reason ||
    value?.lastError?.error ||
    value?.lastError?.message ||
    value?.lastError?.reason ||
    fallback
  );
};

const isExpectedStartCancellation = (payload = {}) =>
  payload?.success === false &&
  payload?.code === "BACKEND_START_CANCELLED" &&
  payload?.cancelled === true &&
  payload?.expected === true;

export const useBackendEngineStore = defineStore("backendEngine", () => {
  const status = ref("idle");
  const phase = ref("idle");
  const error = ref("");
  const recoveryHint = ref("");
  const diagnostic = ref(null);
  const port = ref(null);
  const processRunning = ref(false);
  const ready = ref(false);
  const startedAt = ref(null);
  const readyAt = ref(null);
  const lastExit = ref(null);
  const lastError = ref(null);

  const isRunning = computed(() => status.value === "running" && ready.value);
  const isPreparing = computed(() => status.value === "preparing");
  const isStopping = computed(() => status.value === "stopping");
  const isBusy = computed(() => isPreparing.value || isStopping.value);
  const hasFailed = computed(() => status.value === "failed");
  const phaseLabel = computed(() => PHASE_LABELS[phase.value] || PHASE_LABELS.preparing);
  const runDisabled = computed(() => !isRunning.value);
  const runDisabledTooltip = computed(() => {
    if (isRunning.value) return "";
    if (hasFailed.value) {
      return error.value || "Moonshine AI 引擎准备失败，点击打开诊断";
    }
    return phaseLabel.value;
  });

  const applyMetadata = (payload = {}) => {
    if (!payload || typeof payload !== "object") return;
    if (Object.prototype.hasOwnProperty.call(payload, "port")) {
      const nextPort = Number(payload.port);
      port.value = Number.isInteger(nextPort) ? nextPort : null;
    }
    if (Object.prototype.hasOwnProperty.call(payload, "processRunning")) {
      processRunning.value = Boolean(payload.processRunning);
    }
    if (Object.prototype.hasOwnProperty.call(payload, "ready")) {
      ready.value = Boolean(payload.ready);
    }
    if (Object.prototype.hasOwnProperty.call(payload, "startedAt")) {
      startedAt.value = payload.startedAt || null;
    }
    if (Object.prototype.hasOwnProperty.call(payload, "readyAt")) {
      readyAt.value = payload.readyAt || null;
    }
    if (Object.prototype.hasOwnProperty.call(payload, "lastExit")) {
      lastExit.value = payload.lastExit || null;
    }
    if (Object.prototype.hasOwnProperty.call(payload, "lastError")) {
      lastError.value = payload.lastError || null;
    }
    if (payload.diagnostic) {
      diagnostic.value = payload.diagnostic;
    }
    if (payload.recoveryHint) {
      recoveryHint.value = String(payload.recoveryHint);
    }
  };

  const setPreparing = (nextPhase = "preparing", payload = {}) => {
    status.value = "preparing";
    phase.value = nextPhase || "preparing";
    error.value = "";
    recoveryHint.value = "";
    diagnostic.value = null;
    ready.value = false;
    applyMetadata(payload);
  };

  const setPhase = (nextPhase) => {
    if (status.value !== "preparing") {
      status.value = "preparing";
    }
    phase.value = nextPhase || "preparing";
    ready.value = false;
  };

  const setRunning = (payload = {}) => {
    status.value = "running";
    phase.value = "running";
    error.value = "";
    recoveryHint.value = "";
    diagnostic.value = null;
    processRunning.value = true;
    ready.value = true;
    applyMetadata(payload);
  };

  const setStopping = (payload = {}) => {
    status.value = "stopping";
    phase.value = "stopping";
    error.value = "";
    recoveryHint.value = "";
    ready.value = false;
    applyMetadata(payload);
  };

  const setStopped = (payload = {}) => {
    applyMetadata(payload);
    status.value = "stopped";
    phase.value = "stopped";
    error.value = "";
    recoveryHint.value = "";
    diagnostic.value = payload?.diagnostic || null;
    processRunning.value = false;
    ready.value = false;
    startedAt.value = null;
    readyAt.value = null;
  };

  const applyStopResult = (payload = {}) => {
    if (payload?.success !== true && !isExpectedStartCancellation(payload)) {
      return false;
    }
    setStopped(payload);
    return true;
  };

  const setFailed = (message = "", payload = {}) => {
    const details = message && typeof message === "object" ? message : payload;
    applyMetadata(details);
    status.value = "failed";
    phase.value = "failed";
    error.value = getErrorMessage(message, "Moonshine AI 引擎准备失败");
    recoveryHint.value = details?.recoveryHint || details?.lastError?.recoveryHint || "";
    diagnostic.value = details?.diagnostic || details?.lastError?.diagnostic || null;
    lastError.value = details?.lastError || details || null;
    ready.value = false;
    processRunning.value = Boolean(details?.processRunning);
    startedAt.value = null;
    readyAt.value = null;
  };

  const applyServiceEvent = (payload = {}) => {
    if (!payload || typeof payload !== "object") return;
    applyMetadata(payload);

    let nextState = payload.state;
    if (!SERVICE_STATES.has(nextState)) {
      if (payload.running === true || payload.ready === true) {
        nextState = "running";
      } else if (payload.processRunning === true) {
        nextState = "starting";
      } else {
        nextState = "stopped";
      }
    }

    if (nextState === "running" && payload.ready === false) {
      setPreparing(payload.stage || "verifying", payload);
      return;
    }

    switch (nextState) {
      case "starting":
        setPreparing(payload.stage || "startingEngine", payload);
        break;
      case "running":
        setRunning(payload);
        break;
      case "stopping":
        setStopping(payload);
        break;
      case "failed":
        setFailed(payload);
        break;
      default:
        setStopped(payload);
        break;
    }
  };

  const reset = () => {
    status.value = "idle";
    phase.value = "idle";
    error.value = "";
    recoveryHint.value = "";
    diagnostic.value = null;
    port.value = null;
    processRunning.value = false;
    ready.value = false;
    startedAt.value = null;
    readyAt.value = null;
    lastExit.value = null;
    lastError.value = null;
  };

  return {
    status,
    phase,
    error,
    recoveryHint,
    diagnostic,
    port,
    processRunning,
    ready,
    startedAt,
    readyAt,
    lastExit,
    lastError,
    isRunning,
    isPreparing,
    isStopping,
    isBusy,
    hasFailed,
    phaseLabel,
    runDisabled,
    runDisabledTooltip,
    setPreparing,
    setPhase,
    setRunning,
    setStopping,
    setStopped,
    applyStopResult,
    setFailed,
    applyServiceEvent,
    reset,
  };
});
