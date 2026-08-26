import { randomBytes } from "node:crypto";

const APPROVAL_ID = /^apr_[a-z0-9]{16,64}$/;
const SAFE_CLIENT_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_TOOL = /^moonshine.[a-z0-9_.-]{2,128}$/;
const SAFE_POLICY_ID = /^pol_[a-z0-9_]{8,64}$/;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

function boundedTtl(value) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1_000) return DEFAULT_TTL_MS;
  return Math.min(numeric, 60 * 60 * 1000);
}

function safeText(value, maximum = 128) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

function projectSummary(value) {
  const input = value && typeof value === "object" ? value : {};
  const result = {};
  for (const key of ["operation", "mode", "model_id"]) {
    const text = safeText(input[key], 96);
    if (text && !/[\\/]/.test(text)) result[key] = text;
  }
  for (const key of ["item_count", "child_count"]) {
    if (Number.isSafeInteger(input[key]) && input[key] >= 0 && input[key] <= 1_000_000) result[key] = input[key];
  }
  return result;
}

function projectRecord(record) {
  return {
    approval_id: record.id,
    client_id: record.clientId,
    tool: record.tool,
    policy_snapshot_id: record.policyId,
    state: record.state,
    expires_at: new Date(record.expiresAt).toISOString(),
    disconnected: Boolean(record.disconnected),
    summary: projectSummary(record.summary),
  };
}

export class McpApprovalRegistry {
  constructor({ ttlMs = DEFAULT_TTL_MS, nowMs = () => Date.now() } = {}) {
    this.ttlMs = boundedTtl(ttlMs);
    this.nowMs = nowMs;
    this.records = new Map();
  }

  create({ clientId, tool, policyId, requestHash, summary = {} } = {}) {
    this.sweep();
    if (!SAFE_CLIENT_ID.test(String(clientId || "")) || !SAFE_TOOL.test(String(tool || "")) || !SAFE_POLICY_ID.test(String(policyId || "")) || !/^[a-f0-9]{64}$/.test(String(requestHash || ""))) {
      throw new TypeError("MCP approval request is invalid.");
    }
    for (const record of this.records.values()) {
      if (record.state === "pending" && record.clientId === clientId && record.tool === tool && record.policyId === policyId && record.requestHash === requestHash) {
        return projectRecord(record);
      }
    }
    const record = {
      id: `apr_${randomBytes(16).toString("hex")}`,
      clientId,
      tool,
      policyId,
      requestHash,
      summary: projectSummary(summary),
      state: "pending",
      disconnected: false,
      expiresAt: this.nowMs() + this.ttlMs,
    };
    this.records.set(record.id, record);
    return projectRecord(record);
  }

  resolve({ approvalId, approved } = {}) {
    this.sweep();
    const record = this.records.get(approvalId);
    if (!record || !APPROVAL_ID.test(String(approvalId || ""))) return null;
    if (record.state !== "pending") return projectRecord(record);
    record.state = approved === true ? "approved" : "rejected";
    return projectRecord(record);
  }

  consume({ approvalId, clientId, tool, policyId, requestHash } = {}) {
    this.sweep();
    const record = this.records.get(approvalId);
    if (!record || record.state !== "approved") return { accepted: false, code: "CONFIRMATION_REQUIRED" };
    if (record.clientId !== clientId || record.tool !== tool || record.policyId !== policyId || record.requestHash !== requestHash) {
      return { accepted: false, code: "CONFIRMATION_REQUIRED" };
    }
    record.state = "consumed";
    return { accepted: true, approval: projectRecord(record) };
  }

  list({ clientId = null, includeResolved = false } = {}) {
    this.sweep();
    return [...this.records.values()]
      .filter((record) => (!clientId || record.clientId === clientId) && (includeResolved || record.state === "pending"))
      .map(projectRecord);
  }

  disconnect(clientId) {
    if (!SAFE_CLIENT_ID.test(String(clientId || ""))) return [];
    this.sweep();
    const changed = [];
    for (const record of this.records.values()) {
      if (record.clientId === clientId && record.state === "pending") {
        record.disconnected = true;
        changed.push(projectRecord(record));
      }
    }
    return changed;
  }

  recover(clientId) {
    if (!SAFE_CLIENT_ID.test(String(clientId || ""))) return [];
    this.sweep();
    const recovered = [];
    for (const record of this.records.values()) {
      if (record.clientId === clientId && record.state === "pending") {
        record.disconnected = false;
        recovered.push(projectRecord(record));
      }
    }
    return recovered;
  }

  invalidateExcept(policyId) {
    const safePolicyId = typeof policyId === "string" && SAFE_POLICY_ID.test(policyId) ? policyId : null;
    this.sweep();
    const changed = [];
    for (const record of this.records.values()) {
      if (record.state === "pending" && (!safePolicyId || record.policyId !== safePolicyId)) {
        record.state = "cancelled";
        record.disconnected = true;
        changed.push(projectRecord(record));
      }
    }
    return changed;
  }

  sweep() {
    const now = this.nowMs();
    let expired = 0;
    for (const [id, record] of this.records) {
      if (record.expiresAt <= now && ["pending", "approved"].includes(record.state)) {
        record.state = "expired";
        expired += 1;
      }
      if (record.expiresAt + this.ttlMs <= now) this.records.delete(id);
    }
    const pending = [...this.records.values()].filter((record) => record.state === "pending").length;
    return { expired, pending };
  }
}

export function createMcpApprovalRegistry(options) {
  return new McpApprovalRegistry(options);
}
