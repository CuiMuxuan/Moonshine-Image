import assert from "node:assert/strict";
import test from "node:test";

import {
  areMcpPolicySnapshotsEqual,
  createMcpPolicySnapshot,
  getMcpPolicyEligibility,
} from "../src/utils/mcpPolicyEligibility.js";

test("MCP enablement requires both a tool and an allowed directory", () => {
  assert.deepEqual(getMcpPolicyEligibility({ allowedTools: [], allowedRoots: [] }), {
    eligible: false,
    code: "MCP_ALLOWED_TOOL_AND_ROOT_REQUIRED",
    message: "启用 MCP 前至少选择一个允许工具和一个允许目录。",
  });
  assert.equal(
    getMcpPolicyEligibility({ allowedTools: ["moonshine.capabilities"], allowedRoots: [] }).code,
    "MCP_ALLOWED_ROOT_REQUIRED"
  );
  assert.equal(
    getMcpPolicyEligibility({ allowedTools: [], allowedRoots: ["C:\\allowed"] }).code,
    "MCP_ALLOWED_TOOL_REQUIRED"
  );
  assert.equal(
    getMcpPolicyEligibility({
      allowedTools: ["moonshine.capabilities"],
      allowedRoots: ["C:\\allowed"],
    }).eligible,
    true
  );
});

test("MCP persistence snapshots isolate queued saves from later UI edits", () => {
  const policy = {
    enabled: true,
    profileId: "default",
    allowedTools: ["moonshine.capabilities"],
    allowedRoots: ["C:\\allowed"],
    confirmationMode: "full_access",
  };
  const snapshot = createMcpPolicySnapshot(policy);
  policy.allowedTools.push("moonshine.jobs.status");

  assert.deepEqual(snapshot.allowedTools, ["moonshine.capabilities"]);
  assert.equal(snapshot.confirmationMode, "full_access");
  assert.doesNotMatch(JSON.stringify(snapshot), /confirmationRequired/);
  assert.equal(areMcpPolicySnapshotsEqual(snapshot, policy), false);
  assert.equal(areMcpPolicySnapshotsEqual(snapshot, { ...snapshot }), true);
});

test("MCP policy snapshot maps legacy confirmation only while reading", () => {
  assert.equal(createMcpPolicySnapshot({ confirmationRequired: true }).confirmationMode, "read_only");
  assert.equal(createMcpPolicySnapshot({ confirmationRequired: false }).confirmationMode, "auto_approve");
  assert.equal(createMcpPolicySnapshot({ confirmationMode: "invalid" }).confirmationMode, "read_only");
});
