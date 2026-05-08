import { defineStore } from "pinia";
import { computed, ref } from "vue";

const PHASE_LABELS = Object.freeze({
  idle: "正在准备 Moonshine AI 引擎",
  preparing: "正在准备 Moonshine AI 引擎",
  checkingRuntime: "正在检测运行时",
  loadingModel: "正在加载模型",
  startingEngine: "正在启动 AI 引擎",
  verifying: "正在确认可用性",
  running: "Moonshine AI 引擎已就绪",
  failed: "Moonshine AI 引擎准备失败",
});

export const useBackendEngineStore = defineStore("backendEngine", () => {
  const status = ref("idle");
  const phase = ref("idle");
  const error = ref("");

  const isRunning = computed(() => status.value === "running");
  const isPreparing = computed(() => status.value === "preparing");
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

  const setPreparing = (nextPhase = "preparing") => {
    status.value = "preparing";
    phase.value = nextPhase;
    error.value = "";
  };

  const setPhase = (nextPhase) => {
    if (status.value !== "preparing") {
      status.value = "preparing";
    }
    phase.value = nextPhase || "preparing";
  };

  const setRunning = () => {
    status.value = "running";
    phase.value = "running";
    error.value = "";
  };

  const setFailed = (message = "") => {
    status.value = "failed";
    phase.value = "failed";
    error.value = message || "";
  };

  const reset = () => {
    status.value = "idle";
    phase.value = "idle";
    error.value = "";
  };

  return {
    status,
    phase,
    error,
    isRunning,
    isPreparing,
    hasFailed,
    phaseLabel,
    runDisabled,
    runDisabledTooltip,
    setPreparing,
    setPhase,
    setRunning,
    setFailed,
    reset,
  };
});
