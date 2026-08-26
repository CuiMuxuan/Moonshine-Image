import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MCP_CONFIG,
  MCP_ALLOWED_TOOL_OPTIONS,
  MAX_MCP_ALLOWED_ROOTS,
  normalizeConfigToCurrentSchema,
} from "../../src/shared/appConfigSchema.js";
import { normalizeMcpConfig } from "../../src-electron/mcp-config.js";

test("MCP shared config keeps only the five non-secret policy fields", () => {
  const config = normalizeConfigToCurrentSchema({
    mcp: {
      enabled: true,
      profileId: "desktop.default",
      allowedTools: [MCP_ALLOWED_TOOL_OPTIONS[0], "unknown.tool"],
      allowedRoots: ["C:\\trusted"],
      confirmationRequired: false,
      authorization: "Bearer secret",
      refreshToken: "secret",
      clientSecret: "secret",
      authorizationHeader: "Bearer secret",
      credentialPath: "C:\\private",
      descriptor: { endpoint: "127.0.0.1" },
      nested: { password: "secret" },
    },
  });

  assert.deepEqual(config.mcp, {
    enabled: true,
    profileId: "desktop.default",
    allowedTools: [MCP_ALLOWED_TOOL_OPTIONS[0]],
    allowedRoots: ["C:\\trusted"],
    confirmationMode: "auto_approve",
  });
  assert.doesNotMatch(JSON.stringify(config), /secret|private|descriptor|authorization/i);
});

test("MCP metadata falls back to a closed safe default", () => {
  const config = normalizeConfigToCurrentSchema({ mcp: { enabled: "yes", profileId: "../escape" } });
  assert.deepEqual(config.mcp, {
    ...DEFAULT_MCP_CONFIG,
    allowedTools: [],
    allowedRoots: [],
  });
});

test("MCP policy normalization bounds tools and roots without introducing credentials", () => {
  const result = normalizeMcpConfig({
    enabled: true,
    allowedTools: [...MCP_ALLOWED_TOOL_OPTIONS, "unknown.tool"],
    allowedRoots: Array.from({ length: MAX_MCP_ALLOWED_ROOTS + 4 }, (_, index) => `C:\\root-${index}`),
    confirmationRequired: true,
  });
  assert.deepEqual(result.allowedTools, MCP_ALLOWED_TOOL_OPTIONS);
  assert.equal(result.allowedRoots.length, MAX_MCP_ALLOWED_ROOTS);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "token"), false);
});
