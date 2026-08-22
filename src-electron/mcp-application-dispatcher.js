const TOOL_NAMES = Object.freeze([
  "moonshine.capabilities",
  "moonshine.image.process_batch",
  "moonshine.jobs.get",
  "moonshine.jobs.result",
  "moonshine.jobs.cancel",
]);

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const SAFE_STATUS_PATTERN = /^[a-z_]{2,64}$/;

const ROUTES = Object.freeze({
  "moonshine.image.process_batch": ({ params }) => ({
    method: "POST",
    path: "/api/v1/jobs/image-batch-inpaint",
    headers: {
      "Idempotency-Key": params.idempotency_key,
      "X-Moonshine-Client": params.client_id,
      "X-Moonshine-Request-Id": params.request_id,
      "X-Moonshine-Policy-Snapshot": params.policy_snapshot_id,
    },
    body: {
      workspace_id: params.workspace_id,
      items: params.items,
      confirmation: params.confirmation,
    },
  }),
  "moonshine.jobs.get": ({ jobId }) => ({ method: "GET", path: `/api/v1/jobs/${jobId}` }),
  "moonshine.jobs.result": ({ jobId }) => ({ method: "GET", path: `/api/v1/jobs/${jobId}/artifacts` }),
  "moonshine.jobs.cancel": ({ jobId }) => ({ method: "POST", path: `/api/v1/jobs/${jobId}/cancel` }),
});

export class McpApplicationDispatchError extends Error {
  constructor(code = "APP_NOT_RUNNING") {
    super(code);
    this.name = "McpApplicationDispatchError";
    this.code = code;
  }
}

function normalizeJobId(value) {
  return typeof value === "string" && JOB_ID_PATTERN.test(value) ? value : null;
}

function normalizeWorkspaceRelativePath(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 240) return null;
  const normalized = value.trim().replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    /^[A-Za-z]:\//.test(normalized) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized)
  ) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return normalized;
}

function safeJobPayload(value) {
  const input = value && typeof value === "object" ? value : {};
  const result = {};
  if (typeof input.job_id === "string" && JOB_ID_PATTERN.test(input.job_id)) result.job_id = input.job_id;
  if (typeof input.status === "string" && SAFE_STATUS_PATTERN.test(input.status)) result.status = input.status;
  if (Array.isArray(input.artifact_ids)) {
    result.artifact_ids = input.artifact_ids
      .filter((item) => typeof item === "string" && JOB_ID_PATTERN.test(item))
      .slice(0, 100);
  }
  if (Array.isArray(input.artifacts)) {
    result.artifacts = input.artifacts.slice(0, 100).flatMap((item) => {
      if (!item || typeof item !== "object" || typeof item.artifact_id !== "string" || !JOB_ID_PATTERN.test(item.artifact_id)) return [];
      const asset = item.asset && typeof item.asset === "object" ? item.asset : {};
      const artifact = { artifact_id: item.artifact_id };
      if (typeof asset.media_type === "string" && asset.media_type.length <= 128) artifact.mime_type = asset.media_type;
      if (Number.isSafeInteger(asset.size_bytes) && asset.size_bytes >= 0) artifact.size_bytes = asset.size_bytes;
      return [artifact];
    });
  }
  return result;
}

function safeSubmitPayload(value, response) {
  const input = value && typeof value === "object" ? value : {};
  const bodyJobId = typeof input.job_id === "string" && JOB_ID_PATTERN.test(input.job_id) ? input.job_id : null;
  const requestId = typeof input.request_id === "string" && /^req_[a-z0-9]{8,64}$/.test(input.request_id)
    ? input.request_id
    : null;
  const status = input.status === "queued" ? "queued" : null;
  const headers = response?.headers;
  const headerJobId = typeof headers?.get === "function"
    ? headers.get("x-moonshine-job-id")
    : headers && typeof headers === "object"
      ? headers["x-moonshine-job-id"] || headers["X-Moonshine-Job-Id"]
      : null;
  if (Number(response?.status) !== 202 || !bodyJobId || !requestId || !status || headerJobId !== bodyJobId) {
    throw new McpApplicationDispatchError("QUEUE_UNAVAILABLE");
  }
  return { job_id: bodyJobId, request_id: requestId, status };
}

function safeSubmitParams(params) {
  const input = params && typeof params === "object" ? params : {};
  const allowedKeys = new Set(["tool", "workspace_id", "items", "client_id", "request_id", "idempotency_key", "policy_snapshot_id", "confirmation"]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) return null;
  const workspaceId = typeof input.workspace_id === "string" && /^ws_[a-z0-9]{8,64}$/.test(input.workspace_id)
    ? input.workspace_id
    : null;
  const clientId = typeof input.client_id === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(input.client_id)
    ? input.client_id
    : null;
  const requestId = typeof input.request_id === "string" && /^req_[a-z0-9]{8,64}$/.test(input.request_id)
    ? input.request_id
    : null;
  const idempotencyKey = typeof input.idempotency_key === "string" && input.idempotency_key.length > 0 && input.idempotency_key.length <= 160
    ? input.idempotency_key
    : null;
  const policySnapshotId = typeof input.policy_snapshot_id === "string" && /^pol_[a-z0-9_]{8,64}$/.test(input.policy_snapshot_id)
    ? input.policy_snapshot_id
    : null;
  const items = Array.isArray(input.items) && input.items.length >= 1 && input.items.length <= 100 ? input.items : null;
  const confirmation = input.confirmation && typeof input.confirmation === "object" ? input.confirmation : null;
  if (!workspaceId || !clientId || !requestId || !idempotencyKey || !policySnapshotId || !items || !confirmation) return null;
  const safeItems = [];
  const ids = new Set();
  for (const item of items) {
    if (!item || typeof item !== "object") return null;
    if (typeof item.id !== "string" || !/^itm_[a-z0-9]{8,64}$/.test(item.id) || ids.has(item.id)) return null;
    const inputPath = normalizeWorkspaceRelativePath(item.input_path);
    const maskPath = normalizeWorkspaceRelativePath(item.mask_path);
    if (!inputPath || !maskPath) return null;
    const safeItem = { id: item.id, input_path: inputPath, mask_path: maskPath };
    if (item.model_id !== undefined) {
      if (typeof item.model_id !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/.test(item.model_id)) return null;
      safeItem.model_id = item.model_id;
    }
    ids.add(item.id);
    safeItems.push(safeItem);
  }
  if (Object.keys(confirmation).some((key) => !["policy_snapshot_id", "mode", "confirmation_id"].includes(key))) return null;
  if (confirmation.policy_snapshot_id !== policySnapshotId || !["not_required", "confirmed"].includes(confirmation.mode)) return null;
  if (confirmation.mode === "confirmed" && (typeof confirmation.confirmation_id !== "string" || !/^cnf_[a-z0-9]{8,64}$/.test(confirmation.confirmation_id))) return null;
  if (confirmation.mode === "not_required" && confirmation.confirmation_id !== undefined) return null;
  return {
    workspace_id: workspaceId,
    items: safeItems,
    client_id: clientId,
    request_id: requestId,
    idempotency_key: idempotencyKey,
    policy_snapshot_id: policySnapshotId,
    confirmation: { ...confirmation },
  };
}

function mapBackendFailure(response) {
  const status = Number(response?.status);
  const backendCode = String(response?.body?.error?.code || response?.body?.detail?.code || "").trim().toUpperCase();
  if (status === 400 && backendCode === "MISSING_OR_MISMATCHED_MASK") return "MISSING_OR_MISMATCHED_MASK";
  if (status === 400 && backendCode === "UNSUPPORTED_TOOL_OR_MODEL") return "UNSUPPORTED_TOOL_OR_MODEL";
  if (status === 400) return "INVALID_SUBMIT_REQUEST";
  if (status === 403) return "POLICY_DENIED";
  if (status === 409 && backendCode === "IDEMPOTENCY_CONFLICT") return "IDEMPOTENCY_CONFLICT";
  if (status === 409 && backendCode === "POLICY_REVOKED") return "POLICY_REVOKED";
  if (status === 409 && backendCode === "CONFIRMATION_REQUIRED") return "CONFIRMATION_REQUIRED";
  if (status === 503) return "QUEUE_UNAVAILABLE";
  if (status === 404) return "JOB_NOT_FOUND";
  if (status === 409) return "JOB_IN_PROGRESS";
  if (status === 499) return "CANCELLED";
  return "APP_NOT_RUNNING";
}

export function createMcpApplicationDispatcher({ request = null } = {}) {
  if (request !== null && typeof request !== "function") throw new TypeError("MCP dispatcher request must be a function.");

  return {
    async dispatch({ tool, params = {}, policy = null } = {}) {
      if (!TOOL_NAMES.includes(tool)) throw new McpApplicationDispatchError("TOOL_NOT_ALLOWED");
      if (tool === "moonshine.capabilities") return { tools: Array.isArray(policy?.allowedTools) ? policy.allowedTools.slice(0, TOOL_NAMES.length) : [] };
      if (tool === "moonshine.image.process_batch") {
        const safeParams = safeSubmitParams(params);
        if (!safeParams || safeParams.policy_snapshot_id !== policy?.id) {
          throw new McpApplicationDispatchError("INVALID_SUBMIT_REQUEST");
        }
        if (safeParams.items.some((item) => item.model_id !== undefined)) {
          throw new McpApplicationDispatchError("UNSUPPORTED_TOOL_OR_MODEL");
        }
        const route = ROUTES[tool]({ params: safeParams });
        if (!request) throw new McpApplicationDispatchError("APP_NOT_RUNNING");
        let response;
        try {
          response = await request(route);
        } catch {
          throw new McpApplicationDispatchError("APP_NOT_RUNNING");
        }
        if (!response || response.ok !== true) throw new McpApplicationDispatchError(mapBackendFailure(response));
        return safeSubmitPayload(response.body, response);
      }
      const jobId = normalizeJobId(params?.job_id);
      if (!jobId) throw new McpApplicationDispatchError("INVALID_JOB_ID");
      const route = ROUTES[tool];
      if (!route || !request) throw new McpApplicationDispatchError("APP_NOT_RUNNING");
      let response;
      try {
        response = await request(route({ jobId }));
      } catch {
        throw new McpApplicationDispatchError("APP_NOT_RUNNING");
      }
      if (!response || response.ok !== true) throw new McpApplicationDispatchError(mapBackendFailure(response));
      return safeJobPayload(response.body);
    },
  };
}

export { JOB_ID_PATTERN, ROUTES, TOOL_NAMES, safeJobPayload, safeSubmitParams };
