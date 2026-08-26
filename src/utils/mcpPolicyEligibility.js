export const getMcpPolicyEligibility = (policy = {}) => {
  const hasAllowedTools = Array.isArray(policy.allowedTools) && policy.allowedTools.length > 0;
  const hasAllowedRoots = Array.isArray(policy.allowedRoots) && policy.allowedRoots.length > 0;

  if (hasAllowedTools && hasAllowedRoots) {
    return { eligible: true, code: "", message: "" };
  }
  if (!hasAllowedTools && !hasAllowedRoots) {
    return {
      eligible: false,
      code: "MCP_ALLOWED_TOOL_AND_ROOT_REQUIRED",
      message: "启用 MCP 前至少选择一个允许工具和一个允许目录。",
    };
  }
  if (!hasAllowedTools) {
    return {
      eligible: false,
      code: "MCP_ALLOWED_TOOL_REQUIRED",
      message: "启用 MCP 前至少选择一个允许工具。",
    };
  }
  return {
    eligible: false,
    code: "MCP_ALLOWED_ROOT_REQUIRED",
    message: "启用 MCP 前至少选择一个允许目录。",
  };
};

export const createMcpPolicySnapshot = (policy = {}) => ({
  enabled: policy.enabled === true,
  profileId: typeof policy.profileId === "string" ? policy.profileId : "",
  allowedTools: Array.isArray(policy.allowedTools)
    ? policy.allowedTools.filter((tool) => typeof tool === "string")
    : [],
  allowedRoots: Array.isArray(policy.allowedRoots)
    ? policy.allowedRoots.filter((root) => typeof root === "string")
    : [],
  // confirmationRequired is only a read-compatibility input for pre-Phase 117
  // settings. New renderer saves never send it back to the main process.
  confirmationMode: ["read_only", "auto_approve", "full_access"].includes(policy.confirmationMode)
    ? policy.confirmationMode
    : policy.confirmationRequired === false
      ? "auto_approve"
      : "read_only",
});

export const areMcpPolicySnapshotsEqual = (left, right) =>
  JSON.stringify(createMcpPolicySnapshot(left)) === JSON.stringify(createMcpPolicySnapshot(right));
