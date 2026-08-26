export const MCP_CONFIRMATION_MODES = Object.freeze([
  "read_only",
  "auto_approve",
  "full_access",
]);

const MCP_CONFIRMATION_MODE_SET = new Set(MCP_CONFIRMATION_MODES);

export function normalizeMcpConfirmationMode(policy = null) {
  const candidate = policy?.confirmationMode ?? policy?.confirmation_mode;
  if (typeof candidate === "string" && MCP_CONFIRMATION_MODE_SET.has(candidate)) return candidate;
  // Existing profiles predate the explicit three-mode policy. They retain their
  // current behavior until the configuration migration persists a new value.
  return "auto_approve";
}

export function mcpPolicyAllowsWrite(policy = null) {
  return normalizeMcpConfirmationMode(policy) !== "read_only";
}

export function mcpPolicyBypassesTrustedDirectories(policy = null) {
  return normalizeMcpConfirmationMode(policy) === "full_access";
}

export function projectMcpPolicy(policy = null) {
  const input = policy && typeof policy === "object" ? policy : {};
  const result = { confirmation_mode: normalizeMcpConfirmationMode(input) };
  if (typeof input.id === "string" && /^pol_[a-z0-9_]{8,64}$/.test(input.id)) result.policy_snapshot_id = input.id;
  if (Array.isArray(input.allowedTools)) {
    result.allowed_tools = input.allowedTools
      .filter((tool) => typeof tool === "string" && tool.length <= 128)
      .slice(0, 64);
  }
  return result;
}

export function assertMcpWriteAllowed(policy = null) {
  if (!mcpPolicyAllowsWrite(policy)) {
    const error = new Error("POLICY_READ_ONLY");
    error.code = "POLICY_READ_ONLY";
    throw error;
  }
}
