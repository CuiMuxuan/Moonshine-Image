import { MCP_TOOL_NAMES, McpBridge } from "./mcp-bridge.js";

export const MCP_IPC_CHANNELS = Object.freeze({
  getState: "mcp-get-state",
  getActivity: "mcp-get-activity",
  getClientConfiguration: "mcp-get-client-configuration",
  probeExternalProxy: "mcp-probe-external-proxy",
  getClientSessions: "mcp-get-client-sessions",
  disconnectClient: "mcp-disconnect-client",
  getApprovals: "mcp-get-approvals",
  resolveApproval: "mcp-resolve-approval",
  openArtifactInEditor: "mcp-open-artifact-in-editor",
});

const ACTIVITY_OUTCOMES = new Set(["accepted", "rejected", "pending", "completed", "failed", "cancelled"]);
const ACTIVITY_CODES = new Set([
  "APP_NOT_RUNNING",
  "MCP_ARTIFACT_NOT_FOUND",
  "MCP_ARTIFACT_NOT_IMAGE",
  "MCP_BROKER_BOOTSTRAP_FAILED",
  "MCP_BROKER_EXITED",
  "MCP_BROKER_EXITED_UNEXPECTEDLY",
  "MCP_BROKER_PROCESS_ERROR",
  "CONFIRMATION_EXPIRED",
  "CONFIRMATION_REQUIRED",
  "CANCELLED",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_SUBMIT_REQUEST",
  "CONFIRMATION_LIMIT_REACHED",
  "ENVIRONMENT_NOT_READY",
  "INVALID_JOB_ID",
  "INVALID_JOB_GROUP_ID",
  "JOB_GROUP_NOT_FOUND",
  "JOB_IN_PROGRESS",
  "JOB_NOT_FOUND",
  "PATH_NOT_ALLOWED",
  "POLICY_DENIED",
  "POLICY_REVOKED",
  "QUEUE_UNAVAILABLE",
  "UNSUPPORTED_TOOL_OR_MODEL",
  "MISSING_OR_MISMATCHED_MASK",
  "OCR_UNAVAILABLE",
  "OCR_RUNTIME_ERROR",
  "OCR_RESULT_INVALID",
  "SAM_UNAVAILABLE",
  "SAM_RUNTIME_ERROR",
  "TOOL_NOT_ALLOWED",
]);
const REQUEST_ID_PATTERN = /^req_[a-f0-9]{16}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const SAFE_STATUS_PATTERN = /^[a-z_]{2,64}$/;
const CONFIGURATION_SECRET_PATTERN = /(?:token|secret|password|private[_-]?key|\\\.\pipe|--pipe)/i;
const APPROVAL_STATES = new Set(["pending", "approved", "rejected", "expired", "cancelled"]);
const SESSION_STATES = new Set(["connected", "disconnected", "recovering", "idle"]);

function boundedCursor(value) {
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
}

function safeTimestamp(value) {
  return typeof value === "string" && ISO_TIMESTAMP_PATTERN.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function safeActivityValue(value, allowedValues, pattern = null) {
  if (typeof value !== "string" || value.length > 128) return null;
  if (allowedValues && !allowedValues.has(value)) return null;
  if (pattern && !pattern.test(value)) return null;
  return value;
}

function safeText(value, maximum = 128) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) return null;
  return [...value].some((character) => character.charCodeAt(0) < 32) ? null : value;
}

function safeIdentifier(value) {
  return typeof value === "string" && SAFE_ID_PATTERN.test(value) ? value : null;
}

function safeStatus(value, allowed = null) {
  return typeof value === "string" && SAFE_STATUS_PATTERN.test(value) && (!allowed || allowed.has(value))
    ? value
    : null;
}

function projectArtifact(value) {
  if (!value || typeof value !== "object") return null;
  const artifactId = safeIdentifier(value.artifact_id ?? value.artifactId);
  if (!artifactId) return null;
  const result = { artifact_id: artifactId };
  const mimeType = safeText(value.mime_type ?? value.mimeType, 128);
  if (mimeType && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mimeType)) result.mime_type = mimeType;
  const sizeBytes = Number(value.size_bytes ?? value.sizeBytes);
  if (Number.isSafeInteger(sizeBytes) && sizeBytes >= 0) result.size_bytes = sizeBytes;
  return result;
}

function projectFileResult(value) {
  if (!value || typeof value !== "object") return null;
  const status = safeStatus(value.status);
  const code = safeActivityValue(value.code, ACTIVITY_CODES);
  const artifact = projectArtifact(value.artifact);
  return status || code || artifact ? { status, code, artifact } : null;
}

function projectActivity(event) {
  if (!event || typeof event !== "object") return null;
  const approvalSource = event.approval && typeof event.approval === "object" ? event.approval : null;
  const approvalId = safeIdentifier(approvalSource?.approval_id ?? approvalSource?.approvalId);
  const result = {
    cursor: boundedCursor(event.cursor),
    timestamp: safeTimestamp(event.timestamp),
    request_id: safeActivityValue(event.request_id, null, REQUEST_ID_PATTERN),
    tool: typeof event.tool === "string" && MCP_TOOL_NAMES.includes(event.tool) ? event.tool : null,
    outcome: safeActivityValue(event.outcome, ACTIVITY_OUTCOMES),
    code: safeActivityValue(event.code, ACTIVITY_CODES),
    ...(safeText(event.client_id ?? event.clientId) ? { client_id: safeText(event.client_id ?? event.clientId) } : {}),
    client_name: safeText(event.client_name ?? event.clientName),
    client_version: safeText(event.client_version ?? event.clientVersion),
    session_id: safeIdentifier(event.session_id ?? event.sessionId),
    job_id: safeIdentifier(event.job_id ?? event.jobId),
    job_group_id: safeIdentifier(event.job_group_id ?? event.jobGroupId),
    status: safeStatus(event.status),
    approval: approvalId
      ? { approval_id: approvalId, status: safeStatus(approvalSource.status ?? approvalSource.state, APPROVAL_STATES) }
      : null,
    artifacts: Array.isArray(event.artifacts) ? event.artifacts.map(projectArtifact).filter(Boolean).slice(0, 100) : [],
    file_results: Array.isArray(event.file_results ?? event.fileResults)
      ? (event.file_results ?? event.fileResults).map(projectFileResult).filter(Boolean).slice(0, 100)
      : [],
  };
  return result;
}

function projectClientConfiguration(value) {
  const input = value && typeof value === "object" ? value : {};
  const command = safeText(input.command, 1024);
  const args = Array.isArray(input.args)
    ? input.args.map((entry) => safeText(entry, 1024)).filter(Boolean).slice(0, 32)
    : [];
  const unsafe = !command || [command, ...args].some((entry) => CONFIGURATION_SECRET_PATTERN.test(entry));
  if (input.available !== true || unsafe) {
    return { available: false, protocolVersion: null, command: null, args: [], jsonTemplate: null };
  }
  const protocolVersion = safeText(input.protocolVersion ?? input.protocol_version, 64);
  // The packaged Electron executable must run in headless Node mode when a
  // harness starts the stdio proxy. Always project this environment variable
  // so stale/partial provider data cannot launch the desktop window on every
  // harness session switch.
  const server = { command, args, env: { ELECTRON_RUN_AS_NODE: "1" } };
  return {
    available: true,
    protocolVersion,
    command,
    args,
    jsonTemplate: JSON.stringify({ mcpServers: { "Moonshine Image": server } }, null, 2),
  };
}

function projectSession(value) {
  if (!value || typeof value !== "object") return null;
  const sessionId = safeIdentifier(value.session_id ?? value.sessionId);
  const clientName = safeText(value.client_name ?? value.clientName ?? value.client_id ?? value.clientId);
  if (!sessionId || !clientName) return null;
  return {
    sessionId,
    clientName,
    clientVersion: safeText(value.client_version ?? value.clientVersion),
    connectedAt: safeTimestamp(value.connected_at ?? value.connectedAt),
    lastSeenAt: safeTimestamp(value.last_seen_at ?? value.lastSeenAt),
    status: safeStatus(value.status, SESSION_STATES) || "connected",
  };
}

function projectApproval(value) {
  if (!value || typeof value !== "object") return null;
  const approvalId = safeIdentifier(value.approval_id ?? value.approvalId);
  if (!approvalId) return null;
  return {
    approvalId,
    tool: typeof value.tool === "string" && MCP_TOOL_NAMES.includes(value.tool) ? value.tool : null,
    clientName: safeText(value.client_name ?? value.clientName ?? value.client_id ?? value.clientId),
    jobId: safeIdentifier(value.job_id ?? value.jobId),
    jobGroupId: safeIdentifier(value.job_group_id ?? value.jobGroupId),
    createdAt: safeTimestamp(value.created_at ?? value.createdAt),
    expiresAt: safeTimestamp(value.expires_at ?? value.expiresAt),
    status: safeStatus(value.status ?? value.state, APPROVAL_STATES) || "pending",
  };
}

function externalUnavailable(code = "MCP_EXTERNAL_UNAVAILABLE") {
  return { success: false, code };
}

async function invokeProvider(provider, method, args = [], fallbackCode = "MCP_EXTERNAL_UNAVAILABLE") {
  if (!provider || typeof provider[method] !== "function") return externalUnavailable(fallbackCode);
  try {
    return { success: true, data: await provider[method](...args) };
  } catch (error) {
    const code = typeof error?.code === "string" && /^MCP_[A-Z0-9_]{1,96}$/.test(error.code)
      ? error.code
      : fallbackCode;
    return externalUnavailable(code);
  }
}

export function createMcpBridge(options = {}) {
  return new McpBridge(options);
}

function projectMcpState(state = {}) {
  const allowedTools = Array.isArray(state.allowed_tools)
    ? state.allowed_tools.filter((tool) => MCP_TOOL_NAMES.includes(tool))
    : [];
  const result = {
    enabled: state.enabled === true,
    running: state.running === true,
    allowed_tools: allowedTools,
    activity_cursor: boundedCursor(state.activity_cursor),
  };
  if (typeof state.status === "string" && /^[a-z_]{2,32}$/.test(state.status)) result.status = state.status;
  if (typeof state.error_code === "string" && /^MCP_[A-Z0-9_]{1,64}$/.test(state.error_code)) {
    result.error_code = state.error_code;
  }
  return result;
}

export function getMcpState(bridge, manager = null) {
  if (manager && typeof manager.getState === "function") return projectMcpState(manager.getState());
  if (!bridge || typeof bridge !== "object") {
    return { enabled: false, running: false, activity_cursor: 0 };
  }
  const descriptor = typeof bridge.descriptor === "function" ? bridge.descriptor() : null;
  const allowedTools = Array.isArray(descriptor?.allowed_tools)
    ? descriptor.allowed_tools.filter((tool) => MCP_TOOL_NAMES.includes(tool))
    : [];
  return {
    enabled: Boolean(descriptor?.enabled),
    running: Boolean(bridge.isRunning),
    allowed_tools: allowedTools,
    activity_cursor: boundedCursor(bridge.nextCursor ? bridge.nextCursor - 1 : 0),
  };
}

export function registerMcpIpc({
  ipcMain,
  bridge,
  manager = null,
  external = null,
  dispatcher = null,
  openArtifactInEditor = null,
}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new TypeError("MCP IPC requires ipcMain.handle.");
  if (!bridge || typeof bridge.getActivity !== "function") {
    throw new TypeError("MCP IPC requires a bridge instance.");
  }

  ipcMain.handle(MCP_IPC_CHANNELS.getState, async () => getMcpState(bridge, manager));
  ipcMain.handle(MCP_IPC_CHANNELS.getActivity, async (_event, after = 0) =>
    bridge.getActivity(boundedCursor(after)).map(projectActivity).filter(Boolean),
  );
  ipcMain.handle(MCP_IPC_CHANNELS.getClientConfiguration, async () => {
    const result = await invokeProvider(external, "getClientConfiguration");
    return result.success
      ? { success: true, data: projectClientConfiguration(result.data) }
      : { success: true, data: projectClientConfiguration(null) };
  });
  ipcMain.handle(MCP_IPC_CHANNELS.probeExternalProxy, async () => {
    const result = await invokeProvider(external, "probe", [], "MCP_EXTERNAL_PROBE_FAILED");
    if (!result.success) return { success: true, data: { available: false, code: result.code } };
    const available = result.data?.available === true || result.data?.listening === true;
    return {
      success: true,
      data: {
        available,
        code: available ? null : safeActivityValue(result.data?.code, null, /^MCP_[A-Z0-9_]{1,96}$/) || "MCP_EXTERNAL_UNAVAILABLE",
        protocolVersion: safeText(result.data?.protocolVersion ?? result.data?.protocol_version, 64),
      },
    };
  });
  ipcMain.handle(MCP_IPC_CHANNELS.getClientSessions, async () => {
    const result = await invokeProvider(external, "getSessions");
    return { success: true, data: result.success && Array.isArray(result.data) ? result.data.map(projectSession).filter(Boolean).slice(0, 100) : [] };
  });
  ipcMain.handle(MCP_IPC_CHANNELS.disconnectClient, async (_event, sessionId) => {
    const safeSessionId = safeIdentifier(sessionId);
    if (!safeSessionId) return externalUnavailable("MCP_CLIENT_SESSION_INVALID");
    const result = await invokeProvider(external, "disconnect", [safeSessionId], "MCP_CLIENT_DISCONNECT_FAILED");
    return result.success && result.data === true ? { success: true } : externalUnavailable(result.code || "MCP_CLIENT_NOT_FOUND");
  });
  ipcMain.handle(MCP_IPC_CHANNELS.getApprovals, async () => {
    const result = await invokeProvider(dispatcher, "listApprovals", [{}], "MCP_APPROVAL_LIST_FAILED");
    return { success: true, data: result.success && Array.isArray(result.data) ? result.data.map(projectApproval).filter(Boolean).slice(0, 500) : [] };
  });
  ipcMain.handle(MCP_IPC_CHANNELS.resolveApproval, async (_event, approvalId, decision) => {
    const safeApprovalId = safeIdentifier(approvalId);
    if (!safeApprovalId || !["approve", "reject"].includes(decision)) {
      return externalUnavailable("MCP_APPROVAL_ACTION_INVALID");
    }
    const result = await invokeProvider(
      dispatcher,
      "resolveApproval",
      [{ approvalId: safeApprovalId, approved: decision === "approve" }],
      "MCP_APPROVAL_RESOLVE_FAILED",
    );
    return result.success && result.data ? { success: true, data: projectApproval(result.data) } : externalUnavailable(result.code || "MCP_APPROVAL_NOT_FOUND");
  });
  ipcMain.handle(MCP_IPC_CHANNELS.openArtifactInEditor, async (_event, jobId, artifactId) => {
    const safeJobId = safeIdentifier(jobId);
    const safeArtifactId = safeIdentifier(artifactId);
    if (!safeJobId || !safeArtifactId || typeof openArtifactInEditor !== "function") {
      return externalUnavailable("MCP_ARTIFACT_OPEN_INVALID");
    }
    try {
      const opened = await openArtifactInEditor({ jobId: safeJobId, artifactId: safeArtifactId });
      return opened === true || opened?.success === true
        ? { success: true }
        : externalUnavailable(opened?.code || "MCP_ARTIFACT_OPEN_FAILED");
    } catch (error) {
      return externalUnavailable(error?.code || "MCP_ARTIFACT_OPEN_FAILED");
    }
  });
  return MCP_IPC_CHANNELS;
}
