import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import net from "node:net";
import path from "node:path";

import { MCP_TOOL_DEFINITIONS } from "../src/shared/mcpToolDefinitions.js";
import { projectMcpPublicResult } from "./mcp-application-dispatcher.js";

export const MCP_PROTOCOL_VERSION = "moonshine-mcp-v1";
export const MCP_TOOL_NAMES = Object.freeze(
  MCP_TOOL_DEFINITIONS.map((definition) => definition.name),
);

export const MCP_CONFIRMATION_MODES = Object.freeze([
  "read_only",
  "auto_approve",
  "full_access",
]);

const SAFE_ERROR_CODES = new Set([
  "APP_NOT_RUNNING",
  "ENVIRONMENT_NOT_READY",
  "INVALID_SUBMIT_REQUEST",
  "IDEMPOTENCY_CONFLICT",
  "POLICY_DENIED",
  "POLICY_REVOKED",
  "CONFIRMATION_REQUIRED",
  "CONFIRMATION_EXPIRED",
  "QUEUE_UNAVAILABLE",
  "UNSUPPORTED_TOOL_OR_MODEL",
  "MISSING_OR_MISMATCHED_MASK",
  "JOB_NOT_FOUND",
  "JOB_IN_PROGRESS",
  "CANCELLED",
  "INVALID_JOB_ID",
  "INVALID_JOB_GROUP_ID",
  "PATH_NOT_ALLOWED",
  "TOOL_NOT_ALLOWED",
  "BACKEND_CAPABILITY_UNAVAILABLE",
  "OCR_UNAVAILABLE",
  "OCR_RUNTIME_ERROR",
  "OCR_RESULT_INVALID",
  "OCR_INPUT_INVALID",
  "SAM_UNAVAILABLE",
  "SAM_RUNTIME_ERROR",
  "ENVIRONMENT_NOT_READY",
]);

const PATH_ARRAY_FIELDS = new Set(["input_paths", "output_paths", "mask_paths", "sidecar_paths"]);
const PATH_VALUE_FIELDS = new Set(["input_path", "output_path", "mask_path", "sidecar_path"]);
const PATH_FIELDS = new Set([...PATH_ARRAY_FIELDS, ...PATH_VALUE_FIELDS]);
const DEFAULT_MAX_ACTIVITY = 200;
const DEFAULT_MAX_FRAME_BYTES = 64 * 1024;
const MAX_MAX_ACTIVITY = 10_000;
const MAX_FRAME_BYTES = 1024 * 1024;
const SAFE_CLIENT_ID = /^[A-Za-z0-9._-]{1,128}$/;
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const GROUP_ID_PATTERN = /^grp_[a-z0-9]{16,64}$/;
const SAFE_STATUS_PATTERN = /^[a-z_]{2,64}$/;

const WRITE_TOOLS = new Set([
  "moonshine.image.process",
  "moonshine.image.process_batch",
]);
const PATH_TOOLS = new Set([
  "moonshine.ocr.detect",
  "moonshine.masks.generate",
  ...WRITE_TOOLS,
]);

function bridgeError(code, data = undefined) {
  return data === undefined ? { code, message: code } : { code, message: code, data };
}

function asNonEmptyString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function normalizeConfirmationMode(value, legacyConfirmationRequired) {
  if (MCP_CONFIRMATION_MODES.includes(value)) return value;
  if (typeof legacyConfirmationRequired === "boolean") {
    return legacyConfirmationRequired ? "read_only" : "auto_approve";
  }
  return "read_only";
}

function stablePolicyId(profile, roots, tools, confirmationMode) {
  const value = JSON.stringify({ profile, roots, tools, confirmationMode });
  return `pol_mcp_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

export function workspaceIdForRoot(root) {
  const normalized = path.resolve(String(root || "")).replaceAll("\\", "/").toLowerCase();
  return `ws_${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
}

function isPathInsideRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function normalizeBoundedInteger(value, fallback, maximum) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1) return fallback;
  return Math.min(numeric, maximum);
}

function normalizeTools(allowedTools) {
  const requested = allowedTools ? new Set(allowedTools) : new Set(MCP_TOOL_NAMES);
  const tools = MCP_TOOL_NAMES.filter((tool) => requested.has(tool));
  if (!tools.length) {
    const error = new TypeError("McpBridge requires at least one allowed tool.");
    error.code = "MCP_ALLOWED_TOOL_REQUIRED";
    throw error;
  }
  return Object.freeze(tools);
}

function equalToken(expected, supplied) {
  if (typeof supplied !== "string" || !expected || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

function isUnsafeWindowsPath(value) {
  const candidate = String(value || "").trim();
  return /^(?:\\\\[?.]|\\\\\.|\\\\|\/\/)/.test(candidate);
}

function normalizeClientId(value) {
  const clientId = asNonEmptyString(value);
  return clientId && /^[A-Za-z0-9._-]{1,64}$/.test(clientId) ? clientId : null;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestHash(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function auditRequestId(value) {
  return `req_${requestHash(String(value ?? "")).slice(0, 16)}`;
}

function normalizePathFieldName(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s.-]+/g, "_")
    .toLowerCase();
}

function isPathLikeFieldName(value) {
  const compact = value.replaceAll("_", "");
  return compact.endsWith("path") || compact.endsWith("paths");
}

function containsUnsupportedPathField(value, nested = false) {
  if (Array.isArray(value)) return value.some((item) => containsUnsupportedPathField(item, nested));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([entryKey, entryValue]) => {
    const normalized = normalizePathFieldName(entryKey);
    if (isPathLikeFieldName(normalized) && (entryKey !== normalized || nested || !PATH_FIELDS.has(normalized))) return true;
    return containsUnsupportedPathField(entryValue, true);
  });
}

export class McpBridge {
  constructor({
    dispatch = null,
    resolvePath = null,
    maxActivity = DEFAULT_MAX_ACTIVITY,
    maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    now = () => new Date().toISOString(),
  } = {}) {
    if (dispatch !== null && typeof dispatch !== "function") throw new TypeError("McpBridge dispatch must be a function.");
    if (resolvePath !== null && typeof resolvePath !== "function") throw new TypeError("McpBridge resolvePath must be a function.");
    this.dispatch = dispatch;
    this.resolvePath = resolvePath;
    this.maxActivity = normalizeBoundedInteger(maxActivity, DEFAULT_MAX_ACTIVITY, MAX_MAX_ACTIVITY);
    this.maxFrameBytes = normalizeBoundedInteger(maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, MAX_FRAME_BYTES);
    this.now = now;
    this.server = null;
    this.profile = null;
    this.token = null;
    this.policy = null;
    this.activity = [];
    this.nextCursor = 1;
    this.sockets = new Set();
  }

  get isRunning() {
    return Boolean(this.server?.listening);
  }

  getActivity(after = 0) {
    return this.activity.filter((event) => event.cursor > Number(after || 0)).map((event) => ({ ...event }));
  }

  recordActivity(event = {}) {
    const input = event && typeof event === "object" ? event : {};
    this.#record(input);
    return this.activity[this.activity.length - 1] ? { ...this.activity[this.activity.length - 1] } : null;
  }

  async start({
    enabled = false,
    profile,
    token,
    allowedRoots,
    allowedTools,
    confirmationMode,
    confirmationRequired,
  } = {}) {
    if (!enabled) return { enabled: false, running: false };
    if (this.isRunning) return this.descriptor();

    const selectedProfile = asNonEmptyString(profile);
    const selectedToken = asNonEmptyString(token);
    if (!selectedProfile || !selectedToken) throw new TypeError("McpBridge requires an explicit profile and token.");

    const roots = await this.#canonicalizeRoots(allowedRoots);
    const tools = normalizeTools(allowedTools);
    this.profile = selectedProfile;
    this.token = selectedToken;
    const selectedConfirmationMode = normalizeConfirmationMode(confirmationMode, confirmationRequired);
    this.policy = Object.freeze({
      id: stablePolicyId(selectedProfile, roots, tools, selectedConfirmationMode),
      allowedRoots: roots,
      workspaceRegistry: Object.freeze(
        Object.fromEntries(roots.map((root) => [workspaceIdForRoot(root), root])),
      ),
      allowedTools: tools,
      confirmationMode: selectedConfirmationMode,
    });

    this.server = net.createServer((socket) => this.#serve(socket));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen({ host: "127.0.0.1", port: 0 }, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    return this.descriptor();
  }

  descriptor() {
    if (!this.isRunning) return { enabled: Boolean(this.policy), running: false };
    const address = this.server.address();
    return {
      protocol_version: MCP_PROTOCOL_VERSION,
      instance_id: this.policy.id,
      endpoint: { host: "127.0.0.1", port: address.port },
      profile: this.profile,
      policy_snapshot_id: this.policy.id,
      allowed_tools: this.policy.allowedTools.slice(),
      confirmation_mode: this.policy.confirmationMode,
      workspace_ids: Object.keys(this.policy.workspaceRegistry),
    };
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    this.token = null;
    this.profile = null;
    this.policy = null;
  }

  #record({ requestId = null, tool = null, outcome, code = null, clientId = null, clientName = null, clientVersion = null, jobId = null, jobGroupId = null, status = null, artifacts = [] }) {
    const event = {
      cursor: this.nextCursor++,
      timestamp: this.now(),
      request_id: auditRequestId(requestId),
      profile: this.profile,
      tool,
      outcome,
      code,
    };
    if (typeof clientId === "string" && SAFE_CLIENT_ID.test(clientId)) event.client_id = clientId;
    if (typeof clientName === "string" && clientName.length <= 128) event.client_name = clientName;
    if (typeof clientVersion === "string" && clientVersion.length <= 64) event.client_version = clientVersion;
    if (typeof jobId === "string" && JOB_ID_PATTERN.test(jobId)) event.job_id = jobId;
    if (typeof jobGroupId === "string" && GROUP_ID_PATTERN.test(jobGroupId)) event.job_group_id = jobGroupId;
    if (typeof status === "string" && SAFE_STATUS_PATTERN.test(status)) event.status = status;
    if (Array.isArray(artifacts)) event.artifacts = artifacts.slice(0, 100);
    this.activity.push(event);
    if (this.activity.length > this.maxActivity) this.activity.splice(0, this.activity.length - this.maxActivity);
  }

  #send(socket, id, payload) {
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...payload })}\n`);
  }

  #serve(socket) {
    let authorized = false;
    let policy = null;
    let clientId = null;
    let pending = "";
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      pending += chunk;
      let boundary = pending.indexOf("\n");
      while (boundary !== -1) {
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        boundary = pending.indexOf("\n");
        if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
          this.#send(socket, null, { error: bridgeError("REQUEST_TOO_LARGE") });
          socket.end();
          return;
        }
        if (!line) continue;
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          this.#send(socket, null, { error: bridgeError("PARSE_ERROR") });
          continue;
        }
        if (request.jsonrpc !== "2.0" || !Object.hasOwn(request, "id")) {
          this.#send(socket, request?.id ?? null, { error: bridgeError("INVALID_REQUEST") });
          continue;
        }
        const params = request.params && typeof request.params === "object" ? request.params : {};
        if (request.method === "bridge.handshake") {
          const requestedClientId = normalizeClientId(params.client_id);
          if (params.protocol_version !== MCP_PROTOCOL_VERSION) this.#send(socket, request.id, { error: bridgeError("PROTOCOL_MISMATCH") });
          else if (params.profile !== this.profile) this.#send(socket, request.id, { error: bridgeError("PROFILE_DENIED") });
          else if (!equalToken(this.token, params.token)) this.#send(socket, request.id, { error: bridgeError("AUTH_DENIED") });
          else if (!requestedClientId) this.#send(socket, request.id, { error: bridgeError("CLIENT_ID_REQUIRED") });
          else {
            authorized = true;
            policy = this.policy;
            clientId = requestedClientId;
            this.#send(socket, request.id, { result: { protocol_version: MCP_PROTOCOL_VERSION, profile: this.profile, policy_snapshot_id: policy.id } });
          }
          continue;
        }
        if (request.method !== "bridge.call") {
          this.#send(socket, request.id, { error: bridgeError("METHOD_NOT_FOUND") });
          continue;
        }
        if (!authorized || !policy) {
          this.#send(socket, request.id, { error: bridgeError("AUTH_REQUIRED") });
          continue;
        }
        this.#call(params, policy, clientId, request.id).then((response) => this.#send(socket, request.id, response));
      }
      if (Buffer.byteLength(pending, "utf8") > this.maxFrameBytes) {
        this.#send(socket, null, { error: bridgeError("REQUEST_TOO_LARGE") });
        socket.end();
      }
    });
  }

  async #call(params, policy, clientId, requestId) {
    const tool = asNonEmptyString(params.tool);
    if (!this.isRunning || this.policy !== policy) return this.#reject(requestId, tool, "APP_NOT_RUNNING");
    if (!tool || !policy.allowedTools.includes(tool)) return this.#reject(requestId, tool, "TOOL_NOT_ALLOWED");
    if (policy.confirmationMode === "read_only" && WRITE_TOOLS.has(tool)) {
      return this.#reject(requestId, tool, "POLICY_DENIED");
    }
    let canonicalParams = structuredClone(params);
    if (PATH_TOOLS.has(tool)) {
      if (this.#hasDriftedWorkspacePolicy(params, policy)) {
        return this.#reject(requestId, tool, "POLICY_REVOKED");
      }
      if (policy.confirmationMode === "full_access") {
        canonicalParams = this.#stripConfirmation(canonicalParams);
      } else {
        const canonical = await this.#canonicalizePathParams(params, policy, clientId);
        if (!canonical) return this.#reject(requestId, tool, "PATH_NOT_ALLOWED");
        canonicalParams = canonical;
      }
    }
    if (tool.startsWith("moonshine.jobs.") && !/^[A-Za-z0-9_-]{8,128}$/.test(asNonEmptyString(params.job_id) || "")) {
      return this.#reject(requestId, tool, "INVALID_JOB_ID");
    }
    if (tool.startsWith("moonshine.job_groups.") && !/^[A-Za-z0-9_-]{8,128}$/.test(asNonEmptyString(params.job_group_id) || "")) {
      return this.#reject(requestId, tool, "INVALID_JOB_GROUP_ID");
    }
    if (!this.dispatch) return this.#reject(requestId, tool, "APP_NOT_RUNNING");
    try {
      const dispatchParams = structuredClone(canonicalParams);
      delete dispatchParams.tool;
      const result = await this.dispatch({
        tool,
        params: dispatchParams,
        policy: structuredClone(policy),
        requestId: auditRequestId(requestId),
        clientId,
      });
      this.#record({ requestId, tool, outcome: "accepted" });
      return { result: projectMcpPublicResult(tool, result, policy) };
    } catch (error) {
      const code = SAFE_ERROR_CODES.has(error?.code) ? error.code : "APP_NOT_RUNNING";
      return this.#reject(requestId, tool, code);
    }
  }

  #hasDriftedWorkspacePolicy(params, policy) {
    if (!Array.isArray(params.items) && !Object.hasOwn(params, "workspace_id")) return false;
    const requestedPolicyId = asNonEmptyString(params.policy_snapshot_id);
    const confirmationPolicyId = asNonEmptyString(params.confirmation?.policy_snapshot_id);
    return (
      (requestedPolicyId !== null && requestedPolicyId !== policy.id) ||
      (confirmationPolicyId !== null && confirmationPolicyId !== policy.id)
    );
  }

  async #canonicalizeRoots(allowedRoots) {
    const candidates = [...new Set((allowedRoots || []).map(asNonEmptyString).filter(Boolean))];
    if (!candidates.length) {
      const error = new TypeError("McpBridge requires at least one allowed root.");
      error.code = "MCP_ALLOWED_ROOT_REQUIRED";
      throw error;
    }
    const roots = await Promise.all(candidates.map((candidate) => this.#resolveTrustedPath(candidate)));
    if (roots.some((root) => !root)) {
      const error = new TypeError("McpBridge allowed roots must be canonical trusted paths.");
      error.code = "MCP_ALLOWED_ROOT_INVALID";
      throw error;
    }
    return Object.freeze([...new Set(roots)].sort());
  }

  async #resolveTrustedPath(value) {
    const candidate = asNonEmptyString(value);
    if (!candidate || !this.resolvePath || isUnsafeWindowsPath(candidate)) return null;
    let resolved;
    try {
      resolved = await this.resolvePath(candidate);
    } catch {
      return null;
    }
    if (!resolved || typeof resolved !== "object") return null;
    const canonicalPath = asNonEmptyString(resolved.canonical_path);
    if (!canonicalPath || isUnsafeWindowsPath(canonicalPath)) return null;
    for (const field of ["is_symlink", "is_junction", "is_device", "is_unc"]) {
      if (resolved[field] !== false) return null;
    }
    const canonical = path.resolve(canonicalPath);
    return isUnsafeWindowsPath(canonical) ? null : canonical;
  }

  async #canonicalizePathParams(params, policy, clientId) {
    if (Array.isArray(params.items) || Object.hasOwn(params, "workspace_id")) {
      return this.#canonicalizeWorkspaceSubmitParams(params, policy, clientId);
    }
    if (containsUnsupportedPathField(params)) return null;
    const canonical = structuredClone(params);
    const hasInputPath = Object.hasOwn(params, "input_path");
    const inputPaths = Array.isArray(params.input_paths) ? params.input_paths : [];
    if (!hasInputPath && !inputPaths.length) return null;
    for (const field of PATH_ARRAY_FIELDS) {
      if (!Object.hasOwn(params, field)) continue;
      if (!Array.isArray(params[field])) return null;
      const values = await Promise.all(params[field].map((value) => this.#resolveTrustedPath(value)));
      if (!values.length || values.some((value) => !value || !policy.allowedRoots.some((root) => isPathInsideRoot(value, root)))) return null;
      canonical[field] = values;
    }
    for (const field of PATH_VALUE_FIELDS) {
      if (!Object.hasOwn(params, field)) continue;
      const value = await this.#resolveTrustedPath(params[field]);
      if (!value || !policy.allowedRoots.some((root) => isPathInsideRoot(value, root))) return null;
      canonical[field] = value;
    }
    delete canonical.confirmed;
    delete canonical.confirmation_id;
    return canonical;
  }

  async #canonicalizeWorkspaceSubmitParams(params, policy, clientId) {
    const allowed = new Set([
      "tool",
      "workspace_id",
      "items",
      "client_id",
      "request_id",
      "idempotency_key",
      "policy_snapshot_id",
      "confirmation",
      "confirmation_id",
    ]);
    if (Object.keys(params).some((key) => !allowed.has(key))) return null;
    const workspaceId = asNonEmptyString(params.workspace_id);
    const root = workspaceId ? policy.workspaceRegistry?.[workspaceId] : null;
    if (!workspaceId || !/^ws_[a-z0-9]{8,64}$/.test(workspaceId) || !root) return null;
    const client = asNonEmptyString(params.client_id);
    const requestId = asNonEmptyString(params.request_id);
    const idempotencyKey = asNonEmptyString(params.idempotency_key);
    const policySnapshotId = asNonEmptyString(params.policy_snapshot_id);
    if (!client || client !== clientId || !/^[A-Za-z0-9._-]{1,128}$/.test(client)) return null;
    if (!requestId || !/^req_[a-z0-9]{8,64}$/.test(requestId)) return null;
    if (!idempotencyKey || idempotencyKey.length > 160) return null;
    if (!policySnapshotId || policySnapshotId !== policy.id || !/^pol_[a-z0-9_]{8,64}$/.test(policySnapshotId)) return null;
    if (!Array.isArray(params.items) || params.items.length < 1 || params.items.length > 100) return null;
    const ids = new Set();
    const items = [];
    for (const item of params.items) {
      if (!item || typeof item !== "object") return null;
      const id = asNonEmptyString(item.id);
      const inputPath = this.#normalizeWorkspaceRelativePath(item.input_path);
      const maskPath = this.#normalizeWorkspaceRelativePath(item.mask_path);
      const modelId = item.model_id === undefined ? undefined : asNonEmptyString(item.model_id);
      if (!id || !/^itm_[a-z0-9]{8,64}$/.test(id) || ids.has(id) || !inputPath || !maskPath) return null;
      if (modelId !== undefined && (!modelId || !/^[a-z][a-z0-9._-]{0,63}$/.test(modelId))) return null;
      if (!(await this.#workspacePathIsTrusted(root, inputPath)) || !(await this.#workspacePathIsTrusted(root, maskPath))) return null;
      ids.add(id);
      items.push({ id, input_path: inputPath, mask_path: maskPath, ...(modelId === undefined ? {} : { model_id: modelId }) });
    }
    const confirmation = params.confirmation && typeof params.confirmation === "object"
      ? structuredClone(params.confirmation)
      : null;
    if (!confirmation || Object.keys(confirmation).some((key) => !["policy_snapshot_id", "mode", "confirmation_id"].includes(key))) return null;
    if (confirmation.policy_snapshot_id !== policy.id || !["not_required", "confirmed"].includes(confirmation.mode)) return null;
    if (confirmation.mode === "confirmed" && (!/^cnf_[a-z0-9]{8,64}$/.test(String(confirmation.confirmation_id || "")))) return null;
    if (confirmation.mode === "not_required" && confirmation.confirmation_id !== undefined) return null;
    return {
      tool: "moonshine.image.process_batch",
      workspace_id: workspaceId,
      items,
      client_id: client,
      request_id: requestId,
      idempotency_key: idempotencyKey,
      policy_snapshot_id: policySnapshotId,
      confirmation,
    };
  }

  #normalizeWorkspaceRelativePath(value) {
    if (typeof value !== "string" || !value.trim() || value.length > 240) return null;
    const normalized = value.trim().replaceAll("\\", "/");
    if (
      normalized.startsWith("/") ||
      /^[A-Za-z]:\//.test(normalized) ||
      normalized.startsWith("//") ||
      normalized.includes("://")
    ) return null;
    const parts = normalized.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) return null;
    return normalized;
  }

  async #workspacePathIsTrusted(root, relativePath) {
    const candidate = path.resolve(root, ...relativePath.split("/"));
    if (!isPathInsideRoot(candidate, root) || !this.resolvePath) return false;
    try {
      const resolved = await this.resolvePath(candidate);
      if (!resolved || typeof resolved !== "object" || resolved.is_file !== true) return false;
      if (["is_symlink", "is_junction", "is_device", "is_unc"].some((field) => resolved[field] !== false)) return false;
      const canonical = asNonEmptyString(resolved.canonical_path);
      return Boolean(canonical && isPathInsideRoot(path.resolve(canonical), root));
    } catch {
      return false;
    }
  }

  #stripConfirmation(params) {
    if (!params || typeof params !== "object") return params;
    const copy = structuredClone(params);
    delete copy.confirmation_id;
    delete copy.confirmation;
    return copy;
  }

  #reject(requestId, tool, code, data = undefined) {
    this.#record({ requestId, tool, outcome: "rejected", code });
    return { error: bridgeError(code, data) };
  }
}

export function createMcpToken() {
  return randomBytes(32).toString("base64url");
}
