import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_MCP_CONFIG,
  MCP_ALLOWED_TOOL_OPTIONS,
  containsMcpTokenMaterial,
  normalizeConfigToCurrentSchema,
} from "../../src/shared/appConfigSchema.js";
import { MCP_TOOL_NAMES } from "../../src-electron/mcp-bridge.js";
import { McpConfigError, normalizeMcpConfig } from "../../src-electron/mcp-config.js";

test("MCP configuration metadata defaults closed and omits token fields during schema migration", () => {
  const config = normalizeConfigToCurrentSchema({
    mcp: {
      enabled: "true",
      profileId: " unsafe profile ",
      allowedTools: ["not-allowed"],
      allowedRoots: ["relative/root", "C:\\unsafe\nroot"],
      confirmationRequired: "false",
      token: "must-not-persist",
      nested: { accessToken: "must-not-persist" },
    },
  });

  assert.deepEqual(config.mcp, {
    ...DEFAULT_MCP_CONFIG,
    allowedTools: [],
    allowedRoots: [],
  });
  assert.doesNotMatch(JSON.stringify(config), /must-not-persist|accessToken|"token"/);
});

test("MCP configuration normalizes explicit safe metadata without enabling unlisted tools", () => {
  const windowsRoot = path.join(path.parse(process.cwd()).root, "moonshine-mcp-inputs");
  const normalized = normalizeMcpConfig({
    enabled: true,
    profileId: " desktop.default ",
    allowedTools: [
      "moonshine.jobs.cancel",
      "not-allowed",
      "moonshine.capabilities",
      "moonshine.jobs.cancel",
    ],
    allowedRoots: [windowsRoot, windowsRoot.replaceAll("\\", "/"), "relative/root", "\\\\server\\share"],
    confirmationRequired: false,
  });

  assert.equal(normalized.enabled, true);
  assert.equal(normalized.profileId, "desktop.default");
  assert.deepEqual(normalized.allowedTools, ["moonshine.capabilities", "moonshine.jobs.cancel"]);
  assert.equal(normalized.allowedRoots.length, 1);
  assert.equal(normalized.confirmationRequired, false);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.allowedTools), true);
  assert.equal(Object.isFrozen(normalized.allowedRoots), true);
  assert.deepEqual(MCP_ALLOWED_TOOL_OPTIONS, MCP_TOOL_NAMES);
});

test("MCP configuration rejects token material instead of retaining it", () => {
  for (const value of [
    { token: "secret" },
    { authorization: "Bearer secret" },
    { nested: { access_token: "secret" } },
    { refreshToken: "secret" },
    { clientSecret: "secret" },
    { authorizationHeader: "Bearer secret" },
    { credentialPath: "C:\\private" },
  ]) {
    assert.equal(containsMcpTokenMaterial(value), true);
    assert.throws(
      () => normalizeMcpConfig(value),
      (error) => error instanceof McpConfigError && error.code === "MCP_TOKEN_MATERIAL_REJECTED"
    );
  }
});

test("MCP configuration rejects fields outside the fixed policy schema", () => {
  assert.throws(
    () => normalizeMcpConfig({ descriptor: { endpoint: "127.0.0.1" } }),
    (error) => error instanceof McpConfigError && error.code === "MCP_CONFIG_INVALID"
  );
});
