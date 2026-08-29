import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  createDefaultAppConfig,
  MCP_ALLOWED_TOOL_OPTIONS,
  MCP_READ_ONLY_TOOL_OPTIONS,
  normalizeConfigToCurrentSchema,
} from "../../src/shared/appConfigSchema.js";
import {
  MCP_TOOL_DEFINITIONS,
  getMcpReadOnlyToolNames,
} from "../../src/shared/mcpToolDefinitions.js";
import { TOOL_DEFINITIONS, TOOL_NAMES } from "../../src-electron/mcp-application-dispatcher.js";
import {
  ensureMcpManagedRootDirectory,
  resolveMcpManagedImageOutputRoot,
  synchronizeMcpManagedRoot,
} from "../../src-electron/mcp-config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("MCP read-only defaults are derived from the registered tool capabilities", () => {
  const registeredReadOnly = TOOL_DEFINITIONS
    .filter((definition) => definition.access === "read")
    .map((definition) => definition.name);

  assert.deepEqual(getMcpReadOnlyToolNames(TOOL_DEFINITIONS), registeredReadOnly);
  assert.deepEqual(MCP_READ_ONLY_TOOL_OPTIONS, registeredReadOnly);
  assert.deepEqual(MCP_ALLOWED_TOOL_OPTIONS, TOOL_NAMES);
  assert.deepEqual(
    MCP_TOOL_DEFINITIONS.map((definition) => definition.name),
    TOOL_NAMES,
  );
});

test("new app configs receive read-only tools while persisted explicit policies stay closed", () => {
  const fresh = createDefaultAppConfig();
  assert.deepEqual(fresh.mcp.allowedTools, MCP_READ_ONLY_TOOL_OPTIONS);

  const explicitEmpty = normalizeConfigToCurrentSchema({
    mcp: { enabled: false, allowedTools: [], allowedRoots: [] },
  });
  assert.deepEqual(explicitEmpty.mcp.allowedTools, []);

  const legacyMissingAllowlist = normalizeConfigToCurrentSchema({
    mcp: { enabled: false, allowedRoots: [] },
  });
  assert.deepEqual(legacyMissingAllowlist.mcp.allowedTools, []);

  const freshWithoutMcp = normalizeConfigToCurrentSchema({});
  assert.deepEqual(freshWithoutMcp.mcp.allowedTools, MCP_READ_ONLY_TOOL_OPTIONS);

  const legacyWithoutMcp = normalizeConfigToCurrentSchema({
    schemaVersion: 14,
    general: { backendPort: 8080 },
  });
  assert.deepEqual(legacyWithoutMcp.mcp.allowedTools, []);
  assert.deepEqual(legacyWithoutMcp.mcp.allowedRoots, []);

  const explicitSubset = normalizeConfigToCurrentSchema({
    mcp: { enabled: false, allowedTools: ["moonshine.jobs.get"], allowedRoots: [] },
  });
  assert.deepEqual(explicitSubset.mcp.allowedTools, ["moonshine.jobs.get"]);
});

test("managed image-output root resolves from download path and image folder", () => {
  const downloadPath = path.join(path.parse(process.cwd()).root, "moonshine-downloads");
  assert.equal(
    resolveMcpManagedImageOutputRoot({
      fileManagement: { downloadPath, imageFolderName: "images" },
    }),
    path.join(downloadPath, "images"),
  );
  assert.equal(resolveMcpManagedImageOutputRoot({ fileManagement: { downloadPath: "", imageFolderName: "images" } }), "");
  assert.equal(
    resolveMcpManagedImageOutputRoot({
      fileManagement: { downloadPath: "C:\\Users\\demo\\Downloads", imageFolderName: "images" },
    }),
    "C:\\Users\\demo\\Downloads\\images",
  );
});

test("managed root directory is created only while it remains allowed", () => {
  const calls = [];
  const fsImpl = { mkdirSync: (value, options) => calls.push({ value, options }) };
  const config = {
    fileManagement: { downloadPath: "C:\\Downloads", imageFolderName: "images" },
    mcp: { allowedRoots: ["c:\\downloads\\images"] },
  };
  assert.equal(ensureMcpManagedRootDirectory(config, fsImpl), "C:\\Downloads\\images");
  assert.deepEqual(calls, [{ value: "C:\\Downloads\\images", options: { recursive: true } }]);
  calls.length = 0;
  assert.equal(ensureMcpManagedRootDirectory({ ...config, mcp: { allowedRoots: [] } }, fsImpl), "");
  assert.deepEqual(calls, []);
});

test("managed root replacement preserves manual roots and honors explicit removal", () => {
  const oldRoot = path.join(path.parse(process.cwd()).root, "moonshine-old", "images");
  const nextRoot = path.join(path.parse(process.cwd()).root, "moonshine-new", "images");
  const manualRoot = path.join(path.parse(process.cwd()).root, "manual-inputs");

  assert.deepEqual(
    synchronizeMcpManagedRoot({
      allowedRoots: [oldRoot, manualRoot],
      previousRoot: oldRoot,
      nextRoot,
    }),
    [nextRoot, manualRoot],
  );

  // Once the old managed root is absent, it was explicitly removed and must
  // not be silently reintroduced when file settings change.
  assert.deepEqual(
    synchronizeMcpManagedRoot({
      allowedRoots: [manualRoot],
      previousRoot: oldRoot,
      nextRoot,
    }),
    [manualRoot],
  );
});

test("managed root matching is case-insensitive on Windows and avoids duplicates", () => {
  assert.deepEqual(
    synchronizeMcpManagedRoot({
      allowedRoots: ["C:\\Images", "C:\\New", "C:\\Manual"],
      previousRoot: "c:/images",
      nextRoot: "c:/new",
    }),
    ["C:\\New", "C:\\Manual"],
  );
});

test("Electron main wires definition-derived defaults and managed-root synchronization", async () => {
  const source = await readFile(path.join(root, "src-electron", "electron-main.js"), "utf8");
  const configManagerSource = await readFile(path.join(root, "src", "config", "ConfigManager.js"), "utf8");
  assert.match(source, /TOOL_DEFINITIONS[\s\S]*filter\(\(definition\) => definition\?\.access === "read"\)/);
  assert.match(source, /resolveMcpManagedImageOutputRoot\(nextConfig\)/);
  assert.match(source, /synchronizeMcpManagedRoot\(\{[\s\S]*previousRoot: previousManagedMcpRoot/);
  assert.match(configManagerSource, /migratedConfig = migrateLegacyConfigShape\(userConfig \|\| \{\}\)/);
  assert.match(configManagerSource, /migratedConfig\.mcp[\s\S]*allowedTools/);
});
