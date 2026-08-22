import { MCP_TOOL_NAMES, McpBridge } from "./mcp-bridge.js";

export const MCP_IPC_CHANNELS = Object.freeze({
  getState: "mcp-get-state",
  getActivity: "mcp-get-activity",
  start: "mcp-start",
  stop: "mcp-stop",
});

const ACTIVITY_OUTCOMES = new Set(["accepted", "rejected"]);
const ACTIVITY_CODES = new Set([
  "APP_NOT_RUNNING",
  "CONFIRMATION_EXPIRED",
  "CONFIRMATION_REQUIRED",
  "CANCELLED",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_SUBMIT_REQUEST",
  "CONFIRMATION_LIMIT_REACHED",
  "ENVIRONMENT_NOT_READY",
  "INVALID_JOB_ID",
  "JOB_IN_PROGRESS",
  "JOB_NOT_FOUND",
  "PATH_NOT_ALLOWED",
  "POLICY_DENIED",
  "POLICY_REVOKED",
  "QUEUE_UNAVAILABLE",
  "UNSUPPORTED_TOOL_OR_MODEL",
  "MISSING_OR_MISMATCHED_MASK",
  "TOOL_NOT_ALLOWED",
]);
const REQUEST_ID_PATTERN = /^req_[a-f0-9]{16}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

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

function projectActivity(event) {
  if (!event || typeof event !== "object") return null;
  return {
    cursor: boundedCursor(event.cursor),
    timestamp: safeTimestamp(event.timestamp),
    request_id: safeActivityValue(event.request_id, null, REQUEST_ID_PATTERN),
    tool: typeof event.tool === "string" && MCP_TOOL_NAMES.includes(event.tool) ? event.tool : null,
    outcome: safeActivityValue(event.outcome, ACTIVITY_OUTCOMES),
    code: safeActivityValue(event.code, ACTIVITY_CODES),
  };
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

export function registerMcpIpc({ ipcMain, bridge, manager = null }) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new TypeError("MCP IPC requires ipcMain.handle.");
  if (!bridge || typeof bridge.getActivity !== "function" || typeof bridge.stop !== "function") {
    throw new TypeError("MCP IPC requires a bridge instance.");
  }

  ipcMain.handle(MCP_IPC_CHANNELS.getState, async () => getMcpState(bridge, manager));
  ipcMain.handle(MCP_IPC_CHANNELS.getActivity, async (_event, after = 0) =>
    bridge.getActivity(boundedCursor(after)).map(projectActivity).filter(Boolean),
  );
  ipcMain.handle(MCP_IPC_CHANNELS.start, async () => {
    if (!manager || typeof manager.start !== "function") {
      return projectMcpState({ ...getMcpState(bridge), status: "failed", error_code: "MCP_MANAGER_UNAVAILABLE" });
    }
    try {
      await manager.start();
    } catch {
      // The manager projects its own safe failure code and never exposes process details.
    }
    return getMcpState(bridge, manager);
  });
  ipcMain.handle(MCP_IPC_CHANNELS.stop, async () => {
    if (manager && typeof manager.stop === "function") await manager.stop({ preservePolicy: true });
    else await bridge.stop();
    return getMcpState(bridge, manager);
  });
  return MCP_IPC_CHANNELS;
}
