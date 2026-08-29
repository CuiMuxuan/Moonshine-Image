import { createHash } from "node:crypto";

import { createMcpApprovalRegistry } from "./mcp-approval-registry.js";
import { projectMcpArtifacts, projectMcpCandidate, projectMcpJob } from "./mcp-artifacts.js";
import { createMcpJobGroupRegistry } from "./mcp-job-groups.js";
import {
  assertMcpWriteAllowed,
  mcpPolicyBypassesTrustedDirectories,
  projectMcpPolicy,
} from "./mcp-policy.js";
import { getMcpToolDefinition } from "../src/shared/mcpToolDefinitions.js";

const MAX_BACKEND_BATCH_ITEMS = 100;
const MAX_CHILD_TASK_ITEMS = 1_000;
const MAX_BATCH_ITEMS = 10_000;
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const GROUP_ID_PATTERN = /^grp_[a-z0-9]{16,64}$/;
const SAFE_STATUS_PATTERN = /^[a-z_]{2,64}$/;
const SAFE_MODEL_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const SAFE_CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_POLICY_ID_PATTERN = /^pol_[a-z0-9_]{8,64}$/;
const SAFE_REQUEST_ID_PATTERN = /^req_[a-z0-9]{8,64}$/;
const SAFE_ITEM_ID_PATTERN = /^itm_[a-z0-9]{8,64}$/;
const TASK_ERROR_CODES = new Set([
  "APP_NOT_RUNNING",
  "ENVIRONMENT_NOT_READY",
  "PATH_NOT_ALLOWED",
  "POLICY_DENIED",
  "POLICY_REVOKED",
  "UNSUPPORTED_TOOL_OR_MODEL",
  "OCR_UNAVAILABLE",
  "OCR_RUNTIME_ERROR",
  "OCR_INPUT_INVALID",
  "SAM_UNAVAILABLE",
  "BACKEND_CAPABILITY_UNAVAILABLE",
  "QUEUE_UNAVAILABLE",
  "CANCELLED",
]);

const EMPTY_INPUT_SCHEMA = Object.freeze({ type: "object", additionalProperties: false });
const workspaceSchema = Object.freeze({ type: "string", pattern: "^ws_[a-z0-9]{8,64}$" });
const jobSchema = Object.freeze({ type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" });
const groupSchema = Object.freeze({ type: "string", pattern: "^grp_[a-z0-9]{16,64}$" });
const operationSchema = Object.freeze({ type: "string", enum: ["remove_text", "remove_watermark", "remove_icon"] });
const modelSchema = Object.freeze({ type: "string", pattern: "^[a-z][a-z0-9._-]{0,63}$" });

function readDefinition(name, description, inputSchema = EMPTY_INPUT_SCHEMA) {
  const metadata = getMcpToolDefinition(name);
  if (!metadata || metadata.access !== "read") {
    throw new Error(`MCP tool access metadata mismatch for ${name}.`);
  }
  return Object.freeze({ name, description, inputSchema, access: "read", async: false });
}

function taskDefinition(name, description, inputSchema) {
  const metadata = getMcpToolDefinition(name);
  if (!metadata || metadata.access !== "task") {
    throw new Error(`MCP tool access metadata mismatch for ${name}.`);
  }
  return Object.freeze({ name, description, inputSchema, access: "task", async: true });
}

/**
 * Single public source for names and schemas. Transports import this list and
 * never generate a second, drifting tools/list contract.
 */
export const TOOL_DEFINITIONS = Object.freeze([
  readDefinition("moonshine.status", "Return Moonshine service availability without paths or tokens."),
  readDefinition("moonshine.capabilities", "Return the stable MCP tool surface and policy summary."),
  readDefinition("moonshine.models.list", "List installed model metadata without filesystem locations."),
  taskDefinition("moonshine.ocr.detect", "Run OCR detection for one trusted image and return a job or safe artifact reference.", Object.freeze({
    type: "object", required: ["input_path"], additionalProperties: false,
    properties: { input_path: { type: "string", minLength: 1, maxLength: 4096 }, model_id: modelSchema, language: { type: "string", minLength: 2, maxLength: 32 }, idempotency_key: { type: "string", minLength: 1, maxLength: 160 } },
  })),
  taskDefinition("moonshine.masks.generate", "Generate OCR, SAM, or OCR-assisted SAM smart-selection masks.", Object.freeze({
    type: "object", required: ["input_path", "mode"], additionalProperties: false,
    properties: { input_path: { type: "string", minLength: 1, maxLength: 4096 }, mode: { type: "string", enum: ["ocr", "sam", "ocr_sam"] }, model_id: modelSchema, sam_model_id: modelSchema, prompt: { type: "object", maxProperties: 16 }, idempotency_key: { type: "string", minLength: 1, maxLength: 160 } },
  })),
  taskDefinition("moonshine.image.process", "Process one image. Outputs are new artifacts and never overwrite the source.", Object.freeze({
    type: "object", required: ["workspace_id", "item", "operation"], additionalProperties: false,
    properties: { workspace_id: workspaceSchema, operation: operationSchema, item: { type: "object" }, model_id: modelSchema, idempotency_key: { type: "string", minLength: 1, maxLength: 160 } },
  })),
  taskDefinition("moonshine.image.process_batch", "Process images. Large requests split into bounded child jobs.", Object.freeze({
    type: "object", required: ["workspace_id", "items", "operation"], additionalProperties: false,
    properties: { workspace_id: workspaceSchema, operation: operationSchema, items: { type: "array", minItems: 1, maxItems: MAX_BATCH_ITEMS, items: { type: "object" } }, model_id: modelSchema, idempotency_key: { type: "string", minLength: 1, maxLength: 160 } },
  })),
  readDefinition("moonshine.jobs.get", "Read a Moonshine job state.", Object.freeze({ type: "object", required: ["job_id"], additionalProperties: false, properties: { job_id: jobSchema } })),
  readDefinition("moonshine.jobs.result", "Read safe artifact references for a completed Moonshine job.", Object.freeze({ type: "object", required: ["job_id"], additionalProperties: false, properties: { job_id: jobSchema } })),
  taskDefinition("moonshine.jobs.cancel", "Cancel a queued or running Moonshine job.", Object.freeze({ type: "object", required: ["job_id"], additionalProperties: false, properties: { job_id: jobSchema } })),
  readDefinition("moonshine.job_groups.get", "Read aggregate state for a Moonshine job group.", Object.freeze({ type: "object", required: ["job_group_id"], additionalProperties: false, properties: { job_group_id: groupSchema } })),
  taskDefinition("moonshine.job_groups.cancel", "Cancel active child jobs in a Moonshine job group.", Object.freeze({ type: "object", required: ["job_group_id"], additionalProperties: false, properties: { job_group_id: groupSchema } })),
]);

export const TOOL_NAMES = Object.freeze(TOOL_DEFINITIONS.map((definition) => definition.name));
const TOOL_BY_NAME = new Map(TOOL_DEFINITIONS.map((definition) => [definition.name, definition]));

const ROUTES = Object.freeze({
  status: () => ({ method: "GET", path: "/api/v1/health" }),
  models: () => ({ method: "GET", path: "/api/v1/moonshine/models" }),
  submitBatch: ({ params }) => ({
    method: "POST",
    path: "/api/v1/jobs/image-batch-inpaint",
    headers: {
      "Idempotency-Key": params.idempotency_key,
      "X-Moonshine-Client": params.client_id,
      "X-Moonshine-Request-Id": params.request_id,
      "X-Moonshine-Policy-Snapshot": params.policy_snapshot_id,
    },
    body: { workspace_id: params.workspace_id, items: params.items, confirmation: params.confirmation },
  }),
  job: ({ jobId }) => ({ method: "GET", path: "/api/v1/jobs/" + jobId }),
  artifacts: ({ jobId }) => ({ method: "GET", path: "/api/v1/jobs/" + jobId + "/artifacts" }),
  cancel: ({ jobId }) => ({ method: "POST", path: "/api/v1/jobs/" + jobId + "/cancel" }),
});

export class McpApplicationDispatchError extends Error {
  constructor(code = "APP_NOT_RUNNING", details = undefined) {
    super(code);
    this.name = "McpApplicationDispatchError";
    this.code = code;
    if (details && typeof details === "object") this.details = details;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function requestHash(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function normalizeJobId(value) { return typeof value === "string" && JOB_ID_PATTERN.test(value) ? value : null; }
function safeText(value, maximum = 128) { return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null; }
function normaliseClientId(value) { return typeof value === "string" && SAFE_CLIENT_ID_PATTERN.test(value) ? value : null; }
function normalisePolicyId(value) { return typeof value === "string" && SAFE_POLICY_ID_PATTERN.test(value) ? value : null; }
function normaliseRequestId(value) { return typeof value === "string" && SAFE_REQUEST_ID_PATTERN.test(value) ? value : null; }
function normaliseIdempotencyKey(value) { return typeof value === "string" && value.length > 0 && value.length <= 160 ? value : null; }
function normaliseModelId(value) { return value === undefined ? undefined : typeof value === "string" && SAFE_MODEL_ID_PATTERN.test(value) ? value : null; }
function normaliseOperation(value) { return ["remove_text", "remove_watermark", "remove_icon"].includes(value) ? value : null; }
function normaliseSelectionMode(value) { return ["ocr", "sam", "ocr_sam"].includes(value) ? value : null; }

function normalizeWorkspaceRelativePath(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 240) return null;
  const normalized = value.trim().replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.startsWith("//") || /^[A-Za-z]:\//.test(normalized) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized)) return null;
  return normalized.split("/").some((part) => !part || part === "." || part === "..") ? null : normalized;
}

function normalizeProcessPath(value, { allowAbsolute = false } = {}) {
  if (allowAbsolute && typeof value === "string") {
    const candidate = value.trim();
    if (
      candidate.length > 0 &&
      candidate.length <= 4096 &&
      (/^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith("\\\\"))
    ) {
      return candidate.replaceAll("/", "\\");
    }
  }
  return normalizeWorkspaceRelativePath(value);
}

function safeSubmitItem(value, { allowAbsolute = false } = {}) {
  if (!value || typeof value !== "object") return null;
  const id = typeof value.id === "string" && SAFE_ITEM_ID_PATTERN.test(value.id) ? value.id : null;
  const inputPath = normalizeProcessPath(value.input_path, { allowAbsolute });
  const maskPath = normalizeProcessPath(value.mask_path, { allowAbsolute });
  const modelId = normaliseModelId(value.model_id);
  if (!id || !inputPath || !maskPath || modelId === null) return null;
  return { id, input_path: inputPath, mask_path: maskPath, ...(modelId === undefined ? {} : { model_id: modelId }) };
}

function safeSubmitParams(params) {
  const input = params && typeof params === "object" ? params : {};
  const allowedKeys = new Set(["tool", "workspace_id", "items", "client_id", "request_id", "idempotency_key", "policy_snapshot_id", "confirmation"]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) return null;
  const workspaceId = typeof input.workspace_id === "string" && /^ws_[a-z0-9]{8,64}$/.test(input.workspace_id) ? input.workspace_id : null;
  const clientId = normaliseClientId(input.client_id);
  const requestId = normaliseRequestId(input.request_id);
  const idempotencyKey = normaliseIdempotencyKey(input.idempotency_key);
  const policySnapshotId = normalisePolicyId(input.policy_snapshot_id);
  const items = Array.isArray(input.items) && input.items.length >= 1 && input.items.length <= MAX_BACKEND_BATCH_ITEMS ? input.items : null;
  const confirmation = input.confirmation && typeof input.confirmation === "object" ? input.confirmation : null;
  if (!workspaceId || !clientId || !requestId || !idempotencyKey || !policySnapshotId || !items || !confirmation) return null;
  const ids = new Set();
  const safeItems = [];
  for (const item of items) {
    const safeItem = safeSubmitItem(item);
    if (!safeItem || ids.has(safeItem.id)) return null;
    ids.add(safeItem.id);
    safeItems.push(safeItem);
  }
  if (Object.keys(confirmation).some((key) => !["policy_snapshot_id", "mode", "confirmation_id"].includes(key))) return null;
  if (confirmation.policy_snapshot_id !== policySnapshotId || !["not_required", "confirmed"].includes(confirmation.mode)) return null;
  if (confirmation.mode === "confirmed" && !/^cnf_[a-z0-9]{8,64}$/.test(String(confirmation.confirmation_id || ""))) return null;
  if (confirmation.mode === "not_required" && confirmation.confirmation_id !== undefined) return null;
  return { workspace_id: workspaceId, items: safeItems, client_id: clientId, request_id: requestId, idempotency_key: idempotencyKey, policy_snapshot_id: policySnapshotId, confirmation: { ...confirmation } };
}

function safeSubmitPayload(value, response) {
  const input = value && typeof value === "object" ? value : {};
  const bodyJobId = normalizeJobId(input.job_id);
  const requestId = normaliseRequestId(input.request_id);
  const headers = response?.headers;
  const headerJobId = typeof headers?.get === "function" ? headers.get("x-moonshine-job-id") : headers?.["x-moonshine-job-id"] || headers?.["X-Moonshine-Job-Id"];
  if (Number(response?.status) !== 202 || !bodyJobId || !requestId || input.status !== "queued" || headerJobId !== bodyJobId) throw new McpApplicationDispatchError("QUEUE_UNAVAILABLE");
  return { job_id: bodyJobId, request_id: requestId, status: "queued" };
}

function mapBackendFailure(response) {
  const status = Number(response?.status);
  const code = String(response?.body?.error?.code || response?.body?.detail?.code || "").trim().toUpperCase();
  if (status === 400 && code === "MISSING_OR_MISMATCHED_MASK") return "MISSING_OR_MISMATCHED_MASK";
  if (status === 400 && code === "UNSUPPORTED_TOOL_OR_MODEL") return "UNSUPPORTED_TOOL_OR_MODEL";
  if (status === 400 && code === "INVALID_WORKSPACE_OR_PATH") return "PATH_NOT_ALLOWED";
  if (status === 400) return "INVALID_SUBMIT_REQUEST";
  if (status === 403) return "POLICY_DENIED";
  if (status === 409 && code === "IDEMPOTENCY_CONFLICT") return "IDEMPOTENCY_CONFLICT";
  if (status === 409 && code === "POLICY_REVOKED") return "POLICY_REVOKED";
  if (status === 409 && code === "CONFIRMATION_REQUIRED") return "CONFIRMATION_REQUIRED";
  if (status === 503) return "QUEUE_UNAVAILABLE";
  if (status === 404) return "JOB_NOT_FOUND";
  if (status === 409) return "JOB_IN_PROGRESS";
  if (status === 499) return "CANCELLED";
  return "APP_NOT_RUNNING";
}

function projectStatus(value) {
  const input = value && typeof value === "object" ? value : {};
  const result = { status: "running" };
  if (typeof input.status === "string" && SAFE_STATUS_PATTERN.test(input.status)) result.status = input.status;
  if (typeof input.version === "string" && input.version.length <= 64) result.version = input.version;
  return result;
}

function projectModels(value) {
  const source = Array.isArray(value?.models) ? value.models : [];
  const models = source.slice(0, 1_000).flatMap((entry) => {
    const id = safeText(entry?.id ?? entry?.name, 128);
    if (!id) return [];
    const model = { id };
    const label = safeText(entry.label ?? entry.name, 160);
    if (label) model.label = label;
    if (typeof entry.installed === "boolean") model.installed = entry.installed;
    if (typeof entry.available === "boolean") model.available = entry.available;
    if (typeof entry.status === "string" && entry.status.length <= 64) model.status = entry.status;
    return [model];
  });
  return { models };
}

function projectExecutorTask(value) {
  const input = value && typeof value === "object" ? value : {};
  const result = projectMcpJob(input, { includeArtifacts: true });
  const artifacts = projectMcpArtifacts(input.artifacts);
  if (artifacts.length && !result.artifacts) result.artifacts = artifacts;
  const source = input.candidates ?? input.regions ?? input.masks;
  const candidates = Array.isArray(source) ? source.slice(0, 256).flatMap((entry) => {
    const candidate = projectMcpCandidate(entry);
    return candidate ? [candidate] : [];
  }) : [];
  if (candidates.length) result.candidates = candidates;
  if (!result.job_id && !result.artifacts && !result.candidates) throw new McpApplicationDispatchError("BACKEND_CAPABILITY_UNAVAILABLE");
  return result;
}

/**
 * Boundary projection for the bridge. This projects every public tool into a
 * narrow, path-free, Base64-free shape even when an executor returns excess
 * backend fields. The bridge should call this immediately before serialising a
 * response to a client.
 */
export function projectMcpPublicResult(tool, value, policy = null) {
  const input = value && typeof value === "object" ? value : {};
  if (tool === "moonshine.status") return projectStatus(input);
  if (tool === "moonshine.capabilities") {
    return {
      tools: TOOL_NAMES.slice(),
      allowed_tools: Array.isArray(input.allowed_tools)
        ? input.allowed_tools.filter((item) => TOOL_BY_NAME.has(item))
        : Array.isArray(policy?.allowedTools)
          ? policy.allowedTools.filter((item) => TOOL_BY_NAME.has(item))
          : TOOL_NAMES.slice(),
      policy: projectMcpPolicy(policy ?? input.policy),
    };
  }
  if (tool === "moonshine.models.list") return projectModels(input);
  if (["moonshine.ocr.detect", "moonshine.masks.generate", "moonshine.image.process", "moonshine.image.process_batch"].includes(tool)) {
    return projectExecutorTask(input);
  }
  if (["moonshine.jobs.get", "moonshine.jobs.cancel"].includes(tool)) return projectMcpJob(input, { includeArtifacts: false });
  if (tool === "moonshine.jobs.result") return projectMcpJob(input, { includeArtifacts: true });
  if (["moonshine.job_groups.get", "moonshine.job_groups.cancel"].includes(tool)) {
    const result = {};
    if (typeof input.job_group_id === "string" && GROUP_ID_PATTERN.test(input.job_group_id)) result.job_group_id = input.job_group_id;
    if (typeof input.status === "string" && SAFE_STATUS_PATTERN.test(input.status)) result.status = input.status;
    const childIds = Array.isArray(input.child_job_ids)
      ? input.child_job_ids.filter((id) => typeof id === "string" && JOB_ID_PATTERN.test(id)).slice(0, 1_000)
      : [];
    if (childIds.length) {
      result.child_job_ids = childIds;
      result.child_count = childIds.length;
    }
    const children = Array.isArray(input.child_jobs)
      ? input.child_jobs.map((job) => projectMcpJob(job, { includeArtifacts: false })).filter((job) => job.job_id).slice(0, 1_000)
      : [];
    if (children.length) result.child_jobs = children;
    return result;
  }
  return {};
}

function splitItems(items, maximum) {
  const chunks = [];
  for (let index = 0; index < items.length; index += maximum) chunks.push(items.slice(index, index + maximum));
  return chunks;
}

function policyAllowsTool(policy, tool) { return !Array.isArray(policy?.allowedTools) || policy.allowedTools.includes(tool); }
function policyMatchesSubmission(policy, params) { return normalisePolicyId(policy?.id) !== null && normalisePolicyId(policy.id) === normalisePolicyId(params?.policy_snapshot_id); }
function makeRequestId(value) { return "req_" + requestHash(value).slice(0, 16); }

function normalizeProcessParams(params, single = false, { allowAbsolute = false } = {}) {
  const input = params && typeof params === "object" ? params : {};
  const allowed = new Set(single ? ["workspace_id", "operation", "item", "model_id", "idempotency_key"] : ["workspace_id", "operation", "items", "model_id", "idempotency_key"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return null;
  const workspaceId = typeof input.workspace_id === "string" && /^ws_[a-z0-9]{8,64}$/.test(input.workspace_id) ? input.workspace_id : null;
  const operation = normaliseOperation(input.operation);
  const modelId = normaliseModelId(input.model_id);
  const rawItems = single ? [input.item] : input.items;
  if (!workspaceId || !operation || modelId === null || !Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > MAX_BATCH_ITEMS) return null;
  const ids = new Set();
  const items = [];
  for (const item of rawItems) {
    const safe = safeSubmitItem(item, { allowAbsolute });
    if (!safe || ids.has(safe.id)) return null;
    ids.add(safe.id);
    items.push(safe);
  }
  const idempotencyKey = input.idempotency_key === undefined ? undefined : normaliseIdempotencyKey(input.idempotency_key);
  if (idempotencyKey === null) return null;
  return { workspace_id: workspaceId, operation, items, ...(modelId === undefined ? {} : { model_id: modelId }), ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}) };
}

function normalizeLegacyBatchParams(params) {
  const safe = safeSubmitParams(params);
  return safe ? {
    workspace_id: safe.workspace_id,
    items: safe.items,
    idempotency_key: safe.idempotency_key,
    client_id: safe.client_id,
    request_id: safe.request_id,
    confirmation: safe.confirmation,
    policy_snapshot_id: safe.policy_snapshot_id,
    legacy: true,
  } : null;
}

function normalizeCapabilityTaskParams(params, kind) {
  const input = params && typeof params === "object" ? params : {};
  const allowed = kind === "ocr" ? new Set(["input_path", "model_id", "language", "idempotency_key"]) : new Set(["input_path", "mode", "model_id", "sam_model_id", "prompt", "idempotency_key"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return null;
  const inputPath = safeText(input.input_path, 4096);
  const modelId = normaliseModelId(input.model_id);
  const idempotencyKey = input.idempotency_key === undefined ? undefined : normaliseIdempotencyKey(input.idempotency_key);
  if (!inputPath || modelId === null || idempotencyKey === null) return null;
  if (kind === "ocr") {
    const language = input.language === undefined ? undefined : safeText(input.language, 32);
    return input.language !== undefined && !language ? null : { input_path: inputPath, ...(modelId === undefined ? {} : { model_id: modelId }), ...(language ? { language } : {}), ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}) };
  }
  const mode = normaliseSelectionMode(input.mode);
  const prompt = input.prompt;
  if (!mode || (prompt !== undefined && (!prompt || typeof prompt !== "object" || Array.isArray(prompt) || Object.keys(prompt).length > 16))) return null;
  const samModelId = normaliseModelId(input.sam_model_id);
  if (samModelId === null) return null;
  return { input_path: inputPath, mode, ...(modelId === undefined ? {} : { model_id: modelId }), ...(samModelId === undefined ? {} : { sam_model_id: samModelId }), ...(prompt ? { prompt: structuredClone(prompt) } : {}), ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}) };
}

/**
 * taskExecutor is application-owned. It is the only permitted path/bytes bridge
 * for OCR and SAM, so missing support is a structured failure, never a
 * fabricated completed job. Results must be new Moonshine-Output artifacts.
 */
export function createMcpApplicationDispatcher({ request = null, taskExecutor = null, statusProvider = null, policyValidator = null, jobProvider = null, approvals = createMcpApprovalRegistry(), jobGroups = createMcpJobGroupRegistry() } = {}) {
  if (request !== null && typeof request !== "function") throw new TypeError("MCP dispatcher request must be a function.");
  if (taskExecutor !== null && typeof taskExecutor !== "function") throw new TypeError("MCP dispatcher taskExecutor must be a function.");
  if (statusProvider !== null && typeof statusProvider !== "function") throw new TypeError("MCP dispatcher statusProvider must be a function.");
  if (policyValidator !== null && typeof policyValidator !== "function") throw new TypeError("MCP dispatcher policyValidator must be a function.");
  if (jobProvider !== null && (typeof jobProvider !== "object" || Array.isArray(jobProvider))) throw new TypeError("MCP dispatcher jobProvider must be an object.");

  let configuredTaskExecutor = taskExecutor;
  let configuredStatusProvider = statusProvider;
  let configuredPolicyValidator = policyValidator;
  let configuredJobProvider = jobProvider;
  const jobGroupOwners = new Map();

  async function perform(route) {
    if (!request) throw new McpApplicationDispatchError("APP_NOT_RUNNING");
    try {
      const response = await request(route);
      if (!response || response.ok !== true) throw new McpApplicationDispatchError(mapBackendFailure(response));
      return response;
    } catch (error) {
      if (error instanceof McpApplicationDispatchError) throw error;
      throw new McpApplicationDispatchError("APP_NOT_RUNNING");
    }
  }

  function assertPolicy(policy, tool) {
    if (!policyAllowsTool(policy, tool)) throw new McpApplicationDispatchError("TOOL_NOT_ALLOWED");
    if (configuredPolicyValidator && configuredPolicyValidator(policy, tool) !== true) throw new McpApplicationDispatchError("POLICY_REVOKED");
  }

  function assertWritePolicy(policy) {
    try { assertMcpWriteAllowed(policy); } catch (error) { throw new McpApplicationDispatchError(error?.code || "POLICY_READ_ONLY"); }
  }

  function registerJobGroup(group, { clientId, policy, local = false } = {}) {
    const groupId = typeof group?.job_group_id === "string" && GROUP_ID_PATTERN.test(group.job_group_id)
      ? group.job_group_id
      : null;
    const policyId = normalisePolicyId(policy?.id);
    if (!groupId || !policyId || !normaliseClientId(clientId)) {
      throw new McpApplicationDispatchError("QUEUE_UNAVAILABLE");
    }
    jobGroupOwners.set(groupId, Object.freeze({
      clientId: normaliseClientId(clientId),
      policyId,
      local: local === true,
    }));
    return group;
  }

  function assertJobGroupAccess(group, policy, clientId) {
    const groupId = typeof group?.job_group_id === "string" ? group.job_group_id : null;
    const owner = groupId ? jobGroupOwners.get(groupId) : null;
    if (!owner || owner.clientId !== clientId) throw new McpApplicationDispatchError("POLICY_DENIED");
    if (owner.policyId !== normalisePolicyId(policy?.id)) throw new McpApplicationDispatchError("POLICY_REVOKED");
    return owner;
  }

  async function getGroupChildren(group, owner, policy, clientId) {
    return await Promise.all(group.child_job_ids.map(async (jobId) => {
      if (owner.local && configuredJobProvider?.get) {
        try {
          const localJob = await configuredJobProvider.get({ jobId, clientId, policy: structuredClone(policy || {}) });
          return localJob || { job_id: jobId, status: "unknown" };
        } catch (error) {
          if (error instanceof McpApplicationDispatchError) throw error;
          throw new McpApplicationDispatchError(error?.code === "POLICY_DENIED" ? "POLICY_DENIED" : "JOB_NOT_FOUND");
        }
      }
      try {
        return projectMcpJob((await perform(ROUTES.job({ jobId }))).body);
      } catch {
        return { job_id: jobId, status: "unknown" };
      }
    }));
  }

  async function cancelJobGroup(group, owner, policy, clientId) {
    jobGroups.cancel(group.job_group_id);
    await Promise.all(group.child_job_ids.map(async (jobId) => {
      if (owner.local && configuredJobProvider?.cancel) {
        try {
          await configuredJobProvider.cancel({ jobId, clientId, policy: structuredClone(policy || {}) });
        } catch {
          // Cancellation is idempotent. Individual state is reconciled below.
        }
        return;
      }
      try {
        await perform(ROUTES.cancel({ jobId }));
      } catch {
        // Cancellation is best effort per legacy backend child.
      }
    }));
  }

  async function cancelRevokedJobGroups(activePolicyId) {
    const tasks = [];
    for (const [groupId, owner] of jobGroupOwners) {
      if (owner.policyId === activePolicyId) continue;
      const group = jobGroups.get(groupId);
      if (!group) {
        jobGroupOwners.delete(groupId);
        continue;
      }
      if (owner.local && configuredJobProvider?.cancel) {
        tasks.push(Promise.all(group.child_job_ids.map(async (jobId) => {
          try {
            await configuredJobProvider.cancel({ jobId, clientId: owner.clientId, policy: { id: owner.policyId } });
          } catch {
            // Revocation must continue cancelling the remaining children.
          }
        })).then(() => jobGroups.cancel(groupId)));
      } else {
        tasks.push(Promise.all(group.child_job_ids.map(async (jobId) => {
          try {
            await perform(ROUTES.cancel({ jobId }));
          } catch {
            // The backend may already have completed this child.
          }
        })).then(() => jobGroups.cancel(groupId)));
      }
    }
    await Promise.all(tasks);
  }

  async function executeTask(tool, params, policy, clientId, clientInfo = null) {
    if (!configuredTaskExecutor) throw new McpApplicationDispatchError("BACKEND_CAPABILITY_UNAVAILABLE");
    const executeOne = async (taskParams) => {
      try {
        const response = await configuredTaskExecutor({ tool, params: structuredClone(taskParams), policy: structuredClone(policy || {}), clientId, clientInfo, output: { directory_name: "Moonshine-Output", overwrite: false, artifact_only: true } });
        return projectExecutorTask(response);
      } catch (error) {
        if (error instanceof McpApplicationDispatchError) throw error;
        const code = typeof error?.code === "string" && TASK_ERROR_CODES.has(error.code)
          ? error.code
          : "BACKEND_CAPABILITY_UNAVAILABLE";
        throw new McpApplicationDispatchError(code);
      }
    };
    if (tool === "moonshine.image.process_batch" && Array.isArray(params?.items) && params.items.length > MAX_CHILD_TASK_ITEMS) {
      const chunks = splitItems(params.items, MAX_CHILD_TASK_ITEMS);
      const children = [];
      for (const items of chunks) children.push(await executeOne({ ...params, items }));
      const childJobIds = children.map((job) => job.job_id).filter((jobId) => JOB_ID_PATTERN.test(String(jobId || "")));
      if (childJobIds.length !== children.length) return { status: "succeeded", child_jobs: children, summary: { item_count: params.items.length, success_count: children.length } };
      return registerJobGroup(
        jobGroups.create({ tool, childJobIds, policyId: policy?.id }),
        { clientId, policy, local: true },
      );
    }
    return executeOne(params);
  }

  async function submitLegacyBatch(params, policy, clientId, seed) {
    if (params.model_id !== undefined || params.items.some((item) => item.model_id !== undefined)) {
      throw new McpApplicationDispatchError("UNSUPPORTED_TOOL_OR_MODEL");
    }
    const policyId = normalisePolicyId(policy?.id);
    if (!policyId) throw new McpApplicationDispatchError("POLICY_DENIED");
    const jobs = [];
    const chunks = splitItems(params.items, Math.min(MAX_CHILD_TASK_ITEMS, MAX_BACKEND_BATCH_ITEMS));
    for (let index = 0; index < chunks.length; index += 1) {
      assertPolicy(policy, "moonshine.image.process_batch");
      const useLegacyIdentity = params.legacy === true && chunks.length === 1;
      const idempotencyKey = useLegacyIdentity
        ? params.idempotency_key
        : params.idempotency_key
          ? (params.idempotency_key + ":" + index).slice(0, 160)
          : "mcp-" + requestHash({ clientId, seed, index, items: chunks[index] }).slice(0, 40);
      const requestId = useLegacyIdentity ? params.request_id : makeRequestId({ clientId, seed, index, idempotencyKey });
      const submissionClientId = useLegacyIdentity ? params.client_id : clientId;
      const confirmation = useLegacyIdentity ? params.confirmation : { policy_snapshot_id: policyId, mode: "not_required" };
      const safe = safeSubmitParams({ workspace_id: params.workspace_id, items: chunks[index], client_id: submissionClientId, request_id: requestId, idempotency_key: idempotencyKey, policy_snapshot_id: policyId, confirmation });
      if (!safe || !policyMatchesSubmission(policy, safe)) throw new McpApplicationDispatchError("INVALID_SUBMIT_REQUEST");
      const response = await perform(ROUTES.submitBatch({ params: safe }));
      jobs.push(safeSubmitPayload(response.body, response));
    }
    if (jobs.length === 1) return jobs[0];
    const group = registerJobGroup(
      jobGroups.create({ tool: "moonshine.image.process_batch", childJobIds: jobs.map((job) => job.job_id), policyId: policy.id }),
      { clientId, policy, local: false },
    );
    return { job_group_id: group.job_group_id, child_job_ids: group.child_job_ids, status: group.status };
  }

  return {
    configure({ taskExecutor: nextTaskExecutor, statusProvider: nextStatusProvider, policyValidator: nextPolicyValidator, jobProvider: nextJobProvider } = {}) {
      if (nextTaskExecutor !== undefined && nextTaskExecutor !== null && typeof nextTaskExecutor !== "function") throw new TypeError("MCP dispatcher taskExecutor must be a function.");
      if (nextStatusProvider !== undefined && nextStatusProvider !== null && typeof nextStatusProvider !== "function") throw new TypeError("MCP dispatcher statusProvider must be a function.");
      if (nextPolicyValidator !== undefined && nextPolicyValidator !== null && typeof nextPolicyValidator !== "function") throw new TypeError("MCP dispatcher policyValidator must be a function.");
      if (nextJobProvider !== undefined && nextJobProvider !== null && (typeof nextJobProvider !== "object" || Array.isArray(nextJobProvider))) throw new TypeError("MCP dispatcher jobProvider must be an object.");
      if (nextTaskExecutor !== undefined) configuredTaskExecutor = nextTaskExecutor;
      if (nextStatusProvider !== undefined) configuredStatusProvider = nextStatusProvider;
      if (nextPolicyValidator !== undefined) configuredPolicyValidator = nextPolicyValidator;
      if (nextJobProvider !== undefined) configuredJobProvider = nextJobProvider;
      return this;
    },
    describeTools: () => TOOL_DEFINITIONS.map((definition) => structuredClone(definition)),
    listApprovals: (options) => approvals.list(options),
    resolveApproval: (options) => approvals.resolve(options),
    sweepApprovals: () => approvals.sweep(),
    onClientDisconnected: (clientId) => approvals.disconnect(clientId),
    recoverClient: (clientId) => approvals.recover(clientId),
    onPolicyChanged: async (policyId = null) => {
      const approvalsResult = typeof approvals.invalidateExcept === "function"
        ? approvals.invalidateExcept(policyId)
        : approvals.sweep();
      await cancelRevokedJobGroups(normalisePolicyId(policyId));
      return approvalsResult;
    },

    async dispatch({ tool, params = {}, policy = null, requestId = null, clientId = null, clientInfo = null } = {}) {
      if (!TOOL_BY_NAME.has(tool)) throw new McpApplicationDispatchError("TOOL_NOT_ALLOWED");
      assertPolicy(policy, tool);
      const safeClientId = normaliseClientId(clientId ?? params.client_id) || "mcp-client";

      if (tool === "moonshine.status") {
        if (configuredStatusProvider) {
          try { return projectStatus(await configuredStatusProvider()); } catch { throw new McpApplicationDispatchError("APP_NOT_RUNNING"); }
        }
        return projectStatus((await perform(ROUTES.status())).body);
      }
      if (tool === "moonshine.capabilities") {
        return { tools: TOOL_NAMES.slice(), allowed_tools: Array.isArray(policy?.allowedTools) ? policy.allowedTools.filter((item) => TOOL_BY_NAME.has(item)) : TOOL_NAMES.slice(), policy: projectMcpPolicy(policy) };
      }
      if (tool === "moonshine.models.list") return projectModels((await perform(ROUTES.models())).body);
      if (tool === "moonshine.ocr.detect" || tool === "moonshine.masks.generate") {
        const normalized = normalizeCapabilityTaskParams(params, tool === "moonshine.ocr.detect" ? "ocr" : "masks");
        if (!normalized) throw new McpApplicationDispatchError("INVALID_SUBMIT_REQUEST");
        return executeTask(tool, normalized, policy, safeClientId, clientInfo);
      }
      if (tool === "moonshine.image.process" || tool === "moonshine.image.process_batch") {
        const isSingle = tool === "moonshine.image.process";
        const normalized = params.operation === undefined && !isSingle
          ? normalizeLegacyBatchParams(params)
          : normalizeProcessParams(params, isSingle, { allowAbsolute: mcpPolicyBypassesTrustedDirectories(policy) });
        if (!normalized) throw new McpApplicationDispatchError("INVALID_SUBMIT_REQUEST");
        assertWritePolicy(policy);
        if (configuredTaskExecutor) return executeTask(tool, normalized, policy, safeClientId, clientInfo);
        // The legacy backend only understands workspace-relative mask jobs. It
        // stays safe for full_access but cannot reinterpret arbitrary paths.
        if (mcpPolicyBypassesTrustedDirectories(policy) && normalized.legacy !== true) throw new McpApplicationDispatchError("BACKEND_CAPABILITY_UNAVAILABLE");
        return submitLegacyBatch(normalized, policy, safeClientId, requestId ?? tool);
      }
      if (tool === "moonshine.jobs.get" || tool === "moonshine.jobs.result" || tool === "moonshine.jobs.cancel") {
        const jobId = normalizeJobId(params?.job_id);
        if (!jobId) throw new McpApplicationDispatchError("INVALID_JOB_ID");
        if (tool === "moonshine.jobs.cancel") assertWritePolicy(policy);
        const providerMethod = tool === "moonshine.jobs.get" ? "get" : tool === "moonshine.jobs.result" ? "result" : "cancel";
        if (configuredJobProvider && typeof configuredJobProvider[providerMethod] === "function") {
          const localJob = await configuredJobProvider[providerMethod]({ jobId, clientId, policy: structuredClone(policy || {}) });
          if (localJob !== null && localJob !== undefined) return localJob;
        }
        const route = tool === "moonshine.jobs.get" ? ROUTES.job({ jobId }) : tool === "moonshine.jobs.result" ? ROUTES.artifacts({ jobId }) : ROUTES.cancel({ jobId });
        const response = await perform(route);
        return tool === "moonshine.jobs.result"
          ? projectMcpJob({ job_id: jobId, status: response.body?.status, artifacts: response.body?.artifacts }, { includeArtifacts: true })
          : projectMcpJob(response.body, { includeArtifacts: false });
      }
      const groupId = typeof params?.job_group_id === "string" ? params.job_group_id : null;
      const group = groupId && GROUP_ID_PATTERN.test(groupId) ? jobGroups.get(groupId) : null;
      if (!group) throw new McpApplicationDispatchError("JOB_GROUP_NOT_FOUND");
      const owner = assertJobGroupAccess(group, policy, safeClientId);
      if (tool === "moonshine.job_groups.cancel") {
        assertWritePolicy(policy);
        await cancelJobGroup(group, owner, policy, safeClientId);
      }
      const children = await getGroupChildren(group, owner, policy, safeClientId);
      const updated = jobGroups.update(groupId, children) || group;
      return { ...updated, child_jobs: children.slice(0, 1_000) };
    },
  };
}

export { JOB_ID_PATTERN, ROUTES, normalizeWorkspaceRelativePath, safeSubmitParams };
