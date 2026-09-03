import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { MCP_ALLOWED_TOOL_OPTIONS } from "src/shared/appConfigSchema";
import { getElectronMcpCapability, hasElectronMcpExternalApi } from "src/utils/electronMcpApi";

const DEFAULT_STATE = Object.freeze({
  enabled: false,
  running: false,
  status: "stopped",
  error_code: null,
  allowed_tools: [],
  activity_cursor: 0,
});

const TOOL_NAMES = new Set(MCP_ALLOWED_TOOL_OPTIONS);

const OUTCOMES = new Set(["accepted", "rejected", "pending", "completed", "failed", "cancelled"]);
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
const STATUS_PATTERN = /^[a-z_]{2,32}$/;
const ERROR_CODE_PATTERN = /^MCP_[A-Z0-9_]{1,64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const SESSION_STATUSES = new Set(["connected", "disconnected", "recovering", "idle"]);
const APPROVAL_STATUSES = new Set(["pending", "approved", "rejected", "expired", "cancelled"]);

const getApi = () => getElectronMcpCapability().api;

const safeCursor = (value) => {
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
};

const safeTimestamp = (value) =>
  typeof value === "string" && ISO_TIMESTAMP_PATTERN.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : null;

const safeText = (value, maximum = 128) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  !Array.from(value).some((character) => character.charCodeAt(0) < 32)
    ? value
    : null;
const safeId = (value) => (typeof value === "string" && SAFE_ID_PATTERN.test(value) ? value : null);
const safeStatus = (value, allowed = null) =>
  typeof value === "string" && STATUS_PATTERN.test(value) && (!allowed || allowed.has(value)) ? value : null;
const safeCode = (value) =>
  typeof value === "string" && (CODES.has(value) || ERROR_CODE_PATTERN.test(value)) ? value : null;
const safeArtifact = (value) => {
  if (!value || typeof value !== "object") return null;
  const artifactId = safeId(value.artifact_id ?? value.artifactId);
  if (!artifactId) return null;
  const result = { artifactId };
  const mimeType = safeText(value.mime_type ?? value.mimeType, 128);
  if (mimeType) result.mimeType = mimeType;
  const sizeBytes = Number(value.size_bytes ?? value.sizeBytes);
  if (Number.isSafeInteger(sizeBytes) && sizeBytes >= 0) result.sizeBytes = sizeBytes;
  return result;
};
const safeFileResult = (value) => {
  if (!value || typeof value !== "object") return null;
  const status = safeStatus(value.status);
  const code = safeCode(value.code);
  const artifact = safeArtifact(value.artifact);
  return status || code || artifact ? { status, code, artifact } : null;
};

const safeActivity = (event) => {
  if (!event || typeof event !== "object") return null;
  return {
    cursor: safeCursor(event.cursor),
    timestamp: safeTimestamp(event.timestamp),
    request_id: typeof event.request_id === "string" && REQUEST_ID_PATTERN.test(event.request_id)
      ? event.request_id
      : null,
    tool: typeof event.tool === "string" && TOOL_NAMES.has(event.tool) ? event.tool : null,
    outcome: typeof event.outcome === "string" && OUTCOMES.has(event.outcome) ? event.outcome : null,
    code: safeCode(event.code),
    clientName: safeText(event.client_name ?? event.clientName),
    clientVersion: safeText(event.client_version ?? event.clientVersion),
    sessionId: safeId(event.session_id ?? event.sessionId),
    jobId: safeId(event.job_id ?? event.jobId),
    jobGroupId: safeId(event.job_group_id ?? event.jobGroupId),
    status: safeStatus(event.status),
    approval: event.approval && typeof event.approval === "object"
      ? {
          approvalId: safeId(event.approval.approval_id ?? event.approval.approvalId),
          status: safeStatus(event.approval.status, APPROVAL_STATUSES),
        }
      : null,
    artifacts: Array.isArray(event.artifacts) ? event.artifacts.map(safeArtifact).filter(Boolean).slice(0, 100) : [],
    fileResults: Array.isArray(event.file_results ?? event.fileResults)
      ? (event.file_results ?? event.fileResults).map(safeFileResult).filter(Boolean).slice(0, 100)
      : [],
  };
};

const safeSession = (value) => {
  if (!value || typeof value !== "object") return null;
  const sessionId = safeId(value.sessionId ?? value.session_id);
  const clientName = safeText(value.clientName ?? value.client_name);
  if (!sessionId || !clientName) return null;
  return {
    sessionId,
    clientName,
    clientVersion: safeText(value.clientVersion ?? value.client_version),
    connectedAt: safeTimestamp(value.connectedAt ?? value.connected_at),
    lastSeenAt: safeTimestamp(value.lastSeenAt ?? value.last_seen_at),
    status: safeStatus(value.status, SESSION_STATUSES) || "connected",
  };
};

const safeApproval = (value) => {
  if (!value || typeof value !== "object") return null;
  const approvalId = safeId(value.approvalId ?? value.approval_id);
  if (!approvalId) return null;
  return {
    approvalId,
    tool: typeof value.tool === "string" && TOOL_NAMES.has(value.tool) ? value.tool : null,
    clientName: safeText(value.clientName ?? value.client_name),
    jobId: safeId(value.jobId ?? value.job_id),
    jobGroupId: safeId(value.jobGroupId ?? value.job_group_id),
    createdAt: safeTimestamp(value.createdAt ?? value.created_at),
    expiresAt: safeTimestamp(value.expiresAt ?? value.expires_at),
    status: safeStatus(value.status, APPROVAL_STATUSES) || "pending",
  };
};

const safeClientConfiguration = (value) => {
  if (!value || typeof value !== "object") {
    return { available: false, protocolVersion: null, command: null, args: [], jsonTemplate: null };
  }
  return {
    available: value.available === true,
    protocolVersion: safeText(value.protocolVersion ?? value.protocol_version, 32),
    command: safeText(value.command, 1024),
    args: Array.isArray(value.args) ? value.args.map((entry) => safeText(entry, 1024)).filter(Boolean).slice(0, 32) : [],
    jsonTemplate: safeText(value.jsonTemplate ?? value.json_template, 8192),
  };
};

const safeState = (value) => {
  if (!value || typeof value !== "object") return { ...DEFAULT_STATE };
  return {
    enabled: value.enabled === true,
    running: value.running === true,
    status: typeof value.status === "string" && STATUS_PATTERN.test(value.status)
      ? value.status
      : DEFAULT_STATE.status,
    error_code: typeof value.error_code === "string" && ERROR_CODE_PATTERN.test(value.error_code)
      ? value.error_code
      : null,
    allowed_tools: Array.isArray(value.allowed_tools)
      ? value.allowed_tools.filter((tool) => TOOL_NAMES.has(tool))
      : [],
    activity_cursor: safeCursor(value.activity_cursor),
  };
};

export const useMcpActivityStore = defineStore("mcpActivity", () => {
  const state = ref({ ...DEFAULT_STATE });
  const activities = ref([]);
  const clientConfiguration = ref(safeClientConfiguration(null));
  const clientSessions = ref([]);
  const approvals = ref([]);
  const loading = ref(false);
  const externalLoading = ref(false);
  const actionLoadingIds = ref([]);
  const error = ref("");
  const externalError = ref("");
  // Policy saves restart the external transport. During that short handoff
  // getMcpClientSessions() can legitimately return an empty snapshot even
  // though the harness reconnects immediately afterwards. Keep the last
  // visible sessions until an empty result has remained stable for a brief
  // grace period so the settings panel never flashes a false empty state.
  let externalRefreshEpoch = 0;
  let pendingEmptySessionsTimer = null;
  const hasActivity = computed(() => activities.value.length > 0);
  const pendingApprovals = computed(() => approvals.value.filter((approval) => approval.status === "pending"));
  const hasExternalApi = computed(() => hasElectronMcpExternalApi(getApi()));

  const applyState = (nextState) => {
    state.value = safeState(nextState);
    return state.value;
  };

  const beginAction = (id) => {
    actionLoadingIds.value = Array.from(new Set([...actionLoadingIds.value, id]));
  };
  const finishAction = (id) => {
    actionLoadingIds.value = actionLoadingIds.value.filter((entry) => entry !== id);
  };
  const isActionLoading = (id) => actionLoadingIds.value.includes(id);

  const refreshExternal = async () => {
    const api = getApi();
    const refreshEpoch = ++externalRefreshEpoch;
    if (!hasElectronMcpExternalApi(api)) {
      clientConfiguration.value = safeClientConfiguration(null);
      if (pendingEmptySessionsTimer) {
        clearTimeout(pendingEmptySessionsTimer);
        pendingEmptySessionsTimer = null;
      }
      clientSessions.value = [];
      approvals.value = [];
      externalError.value = "";
      return { success: false, code: "MCP_EXTERNAL_API_UNAVAILABLE" };
    }
    externalLoading.value = true;
    externalError.value = "";
    try {
      const [configurationResult, sessionsResult, approvalsResult] = await Promise.all([
        api.getMcpClientConfiguration(),
        api.getMcpClientSessions(),
        api.getMcpApprovals(),
      ]);
      if (!configurationResult?.success || !sessionsResult?.success || !approvalsResult?.success) {
        externalError.value = "读取外部 MCP 连接状态失败，请稍后重试。";
        return { success: false, code: "MCP_EXTERNAL_STATE_READ_FAILED" };
      }
      if (refreshEpoch !== externalRefreshEpoch) return { success: false, code: "MCP_EXTERNAL_STATE_STALE" };
      clientConfiguration.value = safeClientConfiguration(configurationResult.data);
      const nextSessions = (Array.isArray(sessionsResult.data) ? sessionsResult.data : []).map(safeSession).filter(Boolean);
      if (pendingEmptySessionsTimer) {
        clearTimeout(pendingEmptySessionsTimer);
        pendingEmptySessionsTimer = null;
      }
      if (nextSessions.length || !clientSessions.value.length) {
        clientSessions.value = nextSessions;
      } else {
        pendingEmptySessionsTimer = setTimeout(() => {
          pendingEmptySessionsTimer = null;
          if (refreshEpoch === externalRefreshEpoch) clientSessions.value = [];
        }, 650);
      }
      approvals.value = (Array.isArray(approvalsResult.data) ? approvalsResult.data : []).map(safeApproval).filter(Boolean);
      return { success: true };
    } catch {
      externalError.value = "读取外部 MCP 连接状态失败，请稍后重试。";
      return { success: false, code: "MCP_EXTERNAL_STATE_READ_FAILED" };
    } finally {
      externalLoading.value = false;
    }
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
      await refreshExternal();
      return { success: true, state: state.value, activities: activities.value };
    } catch {
      error.value = "读取 MCP 活动失败，请稍后重试。";
      return { success: false, code: "MCP_ACTIVITY_READ_FAILED" };
    } finally {
      loading.value = false;
    }
  };

  const disconnectClient = async (sessionId) => {
    const api = getApi();
    if (!hasElectronMcpExternalApi(api) || !safeId(sessionId)) {
      return { success: false, code: "MCP_EXTERNAL_API_UNAVAILABLE" };
    }
    beginAction(sessionId);
    try {
      const result = await api.disconnectMcpClient(sessionId);
      if (!result?.success) return { success: false, code: result?.code || "MCP_CLIENT_DISCONNECT_FAILED" };
      await refreshExternal();
      return { success: true };
    } catch {
      return { success: false, code: "MCP_CLIENT_DISCONNECT_FAILED" };
    } finally {
      finishAction(sessionId);
    }
  };

  const resolveApproval = async (approvalId, decision) => {
    const api = getApi();
    if (!hasElectronMcpExternalApi(api) || !safeId(approvalId) || !["approve", "reject"].includes(decision)) {
      return { success: false, code: "MCP_APPROVAL_ACTION_INVALID" };
    }
    beginAction(approvalId);
    try {
      const result = await api.resolveMcpApproval(approvalId, decision);
      if (!result?.success) return { success: false, code: result?.code || "MCP_APPROVAL_RESOLVE_FAILED" };
      await refresh();
      return { success: true };
    } catch {
      return { success: false, code: "MCP_APPROVAL_RESOLVE_FAILED" };
    } finally {
      finishAction(approvalId);
    }
  };

  const openArtifactInEditor = async (jobId, artifactId) => {
    const api = getApi();
    if (!hasElectronMcpExternalApi(api) || !safeId(jobId) || !safeId(artifactId)) {
      return { success: false, code: "MCP_ARTIFACT_OPEN_INVALID" };
    }
    const actionId = jobId + ":" + artifactId;
    beginAction(actionId);
    try {
      const result = await api.openMcpArtifactInEditor(jobId, artifactId);
      return result?.success ? { success: true } : { success: false, code: result?.code || "MCP_ARTIFACT_OPEN_FAILED" };
    } catch {
      return { success: false, code: "MCP_ARTIFACT_OPEN_FAILED" };
    } finally {
      finishAction(actionId);
    }
  };

  return {
    state,
    activities,
    clientConfiguration,
    clientSessions,
    approvals,
    pendingApprovals,
    loading,
    externalLoading,
    error,
    externalError,
    hasActivity,
    hasExternalApi,
    refresh,
    refreshExternal,
    disconnectClient,
    resolveApproval,
    openArtifactInEditor,
    isActionLoading,
  };
});
