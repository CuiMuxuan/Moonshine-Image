import { computed, ref } from "vue";
import { defineStore } from "pinia";

const DEFAULT_STATE = Object.freeze({
  enabled: false,
  running: false,
  allowed_tools: [],
  activity_cursor: 0,
});

const TOOL_NAMES = Object.freeze([
  "moonshine.capabilities",
  "moonshine.image.process_batch",
  "moonshine.jobs.get",
  "moonshine.jobs.result",
  "moonshine.jobs.cancel",
]);

const OUTCOMES = new Set(["accepted", "rejected"]);
const CODES = new Set([
  "APP_NOT_RUNNING",
  "CANCELLED",
  "CONFIRMATION_EXPIRED",
  "CONFIRMATION_LIMIT_REACHED",
  "CONFIRMATION_REQUIRED",
  "ENVIRONMENT_NOT_READY",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_SUBMIT_REQUEST",
  "INVALID_JOB_ID",
  "JOB_IN_PROGRESS",
  "JOB_NOT_FOUND",
  "MISSING_OR_MISMATCHED_MASK",
  "PATH_NOT_ALLOWED",
  "POLICY_DENIED",
  "POLICY_REVOKED",
  "QUEUE_UNAVAILABLE",
  "TOOL_NOT_ALLOWED",
  "UNSUPPORTED_TOOL_OR_MODEL",
]);
const REQUEST_ID_PATTERN = /^req_[a-f0-9]{16}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const getApi = () => (typeof window === "undefined" ? null : window.electron || null);

const safeCursor = (value) => {
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
};

const safeTimestamp = (value) =>
  typeof value === "string" && ISO_TIMESTAMP_PATTERN.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : null;

const safeActivity = (event) => {
  if (!event || typeof event !== "object") return null;
  return {
    cursor: safeCursor(event.cursor),
    timestamp: safeTimestamp(event.timestamp),
    request_id: typeof event.request_id === "string" && REQUEST_ID_PATTERN.test(event.request_id)
      ? event.request_id
      : null,
    tool: typeof event.tool === "string" && TOOL_NAMES.includes(event.tool) ? event.tool : null,
    outcome: typeof event.outcome === "string" && OUTCOMES.has(event.outcome) ? event.outcome : null,
    code: typeof event.code === "string" && CODES.has(event.code) ? event.code : null,
  };
};

const safeState = (value) => {
  if (!value || typeof value !== "object") return { ...DEFAULT_STATE };
  return {
    enabled: value.enabled === true,
    running: value.running === true,
    allowed_tools: Array.isArray(value.allowed_tools)
      ? value.allowed_tools.filter((tool) => TOOL_NAMES.includes(tool))
      : [],
    activity_cursor: safeCursor(value.activity_cursor),
  };
};

export const useMcpActivityStore = defineStore("mcpActivity", () => {
  const state = ref({ ...DEFAULT_STATE });
  const activities = ref([]);
  const loading = ref(false);
  const stopping = ref(false);
  const starting = ref(false);
  const error = ref("");
  const hasActivity = computed(() => activities.value.length > 0);

  const applyState = (nextState) => {
    state.value = safeState(nextState);
    return state.value;
  };

  const refresh = async () => {
    const api = getApi();
    if (!api?.getMcpState || !api?.getMcpActivity) {
      applyState(null);
      activities.value = [];
      error.value = "当前运行环境未提供 MCP 状态接口。";
      return { success: false, code: "API_UNAVAILABLE" };
    }
    loading.value = true;
    error.value = "";
    try {
      const nextState = await api.getMcpState();
      applyState(nextState);
      const nextEvents = await api.getMcpActivity(0);
      activities.value = (Array.isArray(nextEvents) ? nextEvents : [])
        .map(safeActivity)
        .filter(Boolean)
        .sort((left, right) => left.cursor - right.cursor);
      return { success: true, state: state.value, activities: activities.value };
    } catch {
      error.value = "读取 MCP 活动失败，请稍后重试。";
      return { success: false, code: "MCP_ACTIVITY_READ_FAILED" };
    } finally {
      loading.value = false;
    }
  };

  const stop = async () => {
    const api = getApi();
    if (!api?.stopMcp) return { success: false, code: "API_UNAVAILABLE" };
    stopping.value = true;
    error.value = "";
    try {
      applyState(await api.stopMcp());
      await refresh();
      return { success: true, state: state.value };
    } catch {
      error.value = "停止 MCP 服务失败，请稍后重试。";
      return { success: false, code: "MCP_STOP_FAILED" };
    } finally {
      stopping.value = false;
    }
  };

  const start = async () => {
    const api = getApi();
    if (!api?.startMcp) return { success: false, code: "API_UNAVAILABLE" };
    starting.value = true;
    error.value = "";
    try {
      applyState(await api.startMcp());
      await refresh();
      if (!state.value.running) {
        error.value = "MCP 服务未能启动，请检查允许目录和工具策略。";
        return { success: false, code: "MCP_START_FAILED", state: state.value };
      }
      return { success: true, state: state.value };
    } catch {
      error.value = "启动 MCP 服务失败，请稍后重试。";
      return { success: false, code: "MCP_START_FAILED" };
    } finally {
      starting.value = false;
    }
  };

  return {
    state,
    activities,
    loading,
    stopping,
    starting,
    error,
    hasActivity,
    refresh,
    stop,
    start,
  };
});
