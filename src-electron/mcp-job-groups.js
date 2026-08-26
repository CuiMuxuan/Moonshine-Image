import { randomBytes } from "node:crypto";

const JOB_ID = /^[A-Za-z0-9_-]{8,128}$/;
const GROUP_ID = /^grp_[a-z0-9]{16,64}$/;
const SAFE_STATUS = /^[a-z_]{2,64}$/;

function projectGroup(record) {
  const childJobIds = record.childJobIds.filter((id) => JOB_ID.test(id)).slice(0, 10_000);
  return {
    job_group_id: record.id,
    tool: record.tool,
    status: record.status,
    child_job_ids: childJobIds,
    child_count: childJobIds.length,
    ...(record.policyId ? { policy_snapshot_id: record.policyId } : {}),
  };
}

export class McpJobGroupRegistry {
  constructor() {
    this.groups = new Map();
  }

  create({ tool, childJobIds, policyId = null } = {}) {
    const ids = Array.isArray(childJobIds) ? [...new Set(childJobIds.filter((id) => JOB_ID.test(id)))].slice(0, 10_000) : [];
    if (!ids.length) throw new TypeError("MCP job group requires child jobs.");
    const record = {
      id: `grp_${randomBytes(16).toString("hex")}`,
      tool: typeof tool === "string" && tool.length <= 128 ? tool : "moonshine.image.process_batch",
      childJobIds: ids,
      policyId: typeof policyId === "string" && /^pol_[a-z0-9_]{8,64}$/.test(policyId) ? policyId : null,
      status: "queued",
    };
    this.groups.set(record.id, record);
    return projectGroup(record);
  }

  get(groupId) {
    const record = this.groups.get(groupId);
    return record && GROUP_ID.test(String(groupId || "")) ? projectGroup(record) : null;
  }

  update(groupId, childJobs = []) {
    const record = this.groups.get(groupId);
    if (!record) return null;
    const statuses = Array.isArray(childJobs)
      ? childJobs.map((job) => (typeof job?.status === "string" && SAFE_STATUS.test(job.status) ? job.status : "unknown"))
      : [];
    if (statuses.length && statuses.every((status) => status === "cancelled")) record.status = "cancelled";
    else if (statuses.some((status) => status === "failed")) record.status = "failed";
    else if (statuses.length && statuses.every((status) => status === "succeeded")) record.status = "succeeded";
    else if (statuses.some((status) => ["running", "cancelling"].includes(status))) record.status = "running";
    else if (statuses.some((status) => status === "queued")) record.status = "queued";
    return projectGroup(record);
  }

  cancel(groupId) {
    const record = this.groups.get(groupId);
    if (!record) return null;
    record.status = "cancelling";
    return projectGroup(record);
  }
}

export function createMcpJobGroupRegistry() {
  return new McpJobGroupRegistry();
}

export { GROUP_ID, JOB_ID };
