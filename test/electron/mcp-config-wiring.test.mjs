import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MCP_CONFIG_IPC_CHANNELS,
  McpConfigError,
  canonicalizeMcpConfig,
  registerMcpConfigIpc,
  resolveTrustedMcpDirectory,
  resolveTrustedMcpPath,
} from "../../src-electron/mcp-config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("MCP config IPC exposes only named policy handlers with safe result envelopes", async () => {
  const handlers = new Map();
  registerMcpConfigIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getConfig: () => ({ enabled: true, profileId: "desktop-default", allowedTools: [], allowedRoots: [], confirmationRequired: true }),
    saveConfig: async (value) => ({ ...value, allowedRoots: [] }),
    selectRoot: async () => "C:\\trusted",
  });

  assert.deepEqual([...handlers.keys()], Object.values(MCP_CONFIG_IPC_CHANNELS));
  assert.deepEqual(await handlers.get(MCP_CONFIG_IPC_CHANNELS.getConfig)({}), {
    success: true,
    data: {
      enabled: true,
      profileId: "desktop-default",
      allowedTools: [],
      allowedRoots: [],
      confirmationRequired: true,
    },
  });
  assert.deepEqual(await handlers.get(MCP_CONFIG_IPC_CHANNELS.selectRoot)({}), {
    success: true,
    data: "C:\\trusted",
  });
});

test("MCP config IPC maps token failures to a stable code and never returns raw errors", async () => {
  const handlers = new Map();
  registerMcpConfigIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getConfig: () => ({ token: "secret" }),
    saveConfig: async () => {
      throw new McpConfigError("secret should not escape", "MCP_TOKEN_MATERIAL_REJECTED");
    },
    selectRoot: async () => null,
  });

  assert.deepEqual(await handlers.get(MCP_CONFIG_IPC_CHANNELS.getConfig)({}), {
    success: false,
    code: "MCP_TOKEN_MATERIAL_REJECTED",
    error: "MCP_TOKEN_MATERIAL_REJECTED",
  });
  assert.deepEqual(await handlers.get(MCP_CONFIG_IPC_CHANNELS.saveConfig)({}, { token: "secret" }), {
    success: false,
    code: "MCP_TOKEN_MATERIAL_REJECTED",
    error: "MCP_TOKEN_MATERIAL_REJECTED",
  });
});

test("MCP config IPC and preload wiring stay explicit and bridge remains start-free", async () => {
  const mainSource = await readFile(path.join(root, "src-electron", "electron-main.js"), "utf8");
  const configSource = await readFile(path.join(root, "src-electron", "mcp-config.js"), "utf8");
  const preloadSource = await readFile(path.join(root, "src-electron", "electron-preload.js"), "utf8");
  const panelSource = await readFile(path.join(root, "src/components/global/McpSettingsPanel.vue"), "utf8");
  assert.match(mainSource, /registerMcpConfigIpc\(/);
  assert.match(mainSource, /canonicalMcpConfig = await canonicalizeMcpConfig\(newConfig\.mcp, resolveMcpTrustedDirectory\)/);
  assert.match(mainSource, /canonicalizeMcpConfig\(value, resolveMcpTrustedDirectory\)/);
  assert.match(mainSource, /Object\.keys\(mcp\)\.some\(\(key\) => !MCP_CONFIG_FIELD_NAMES\.includes\(key\)\)/);
  const saveConfigStart = mainSource.indexOf('// IPC handler - save app config');
  const saveConfigEnd = mainSource.indexOf('const configPath = getConfigPath()', saveConfigStart);
  const saveConfigSource = mainSource.slice(saveConfigStart, saveConfigEnd);
  assert.doesNotMatch(saveConfigSource, /console\.error\([^\n]*newConfig/);
  assert.match(saveConfigSource, /INVALID_CONFIGURATION/);
  assert.match(configSource, /selectRoot:\s*"mcp-select-root"/);
  assert.doesNotMatch(mainSource, /mcpBridge\.start\(/);
  assert.match(preloadSource, /getMcpConfig:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("mcp-get-config"\)/);
  assert.match(preloadSource, /saveMcpConfig:\s*\(config\)\s*=>\s*ipcRenderer\.invoke\("mcp-save-config", config\)/);
  assert.match(preloadSource, /selectMcpRoot:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("mcp-select-root"\)/);
  assert.match(panelSource, /getMcpConfig/);
  assert.match(panelSource, /saveMcpConfig/);
  assert.match(panelSource, /selectMcpRoot/);
  assert.match(panelSource, /router\.push\("\/activity\/mcp"\)/);
  assert.match(mainSource, /resolvePath: resolveMcpTrustedPath/);
  assert.match(mainSource, /selectRoot:[\s\S]*resolveMcpTrustedDirectory\(selectedPath\)/);
});

test("MCP root canonicalization rejects relative, UNC, missing, and unsafe directories", async () => {
  const resolver = async (value) => value === "C:\\trusted"
    ? { canonical_path: "C:\\trusted", is_directory: true, is_symlink: false, is_junction: false, is_device: false, is_unc: false }
    : null;

  await assert.rejects(
    () => canonicalizeMcpConfig({ allowedRoots: ["relative/root"] }, resolver),
    (error) => error instanceof McpConfigError && error.code === "MCP_ROOT_INVALID"
  );
  await assert.rejects(
    () => canonicalizeMcpConfig({ allowedRoots: ["\\\\server\\share"] }, resolver),
    (error) => error instanceof McpConfigError && error.code === "MCP_ROOT_INVALID"
  );
  await assert.rejects(
    () => canonicalizeMcpConfig({ allowedRoots: ["C:\\missing"] }, resolver),
    (error) => error instanceof McpConfigError && error.code === "MCP_ROOT_INVALID"
  );
  await assert.rejects(
    () => canonicalizeMcpConfig({ allowedRoots: ["C:\\trusted"] }, async () => ({
      canonical_path: "C:\\trusted",
      is_directory: false,
      is_symlink: false,
      is_junction: false,
      is_device: false,
      is_unc: false,
    })),
    (error) => error instanceof McpConfigError && error.code === "MCP_ROOT_INVALID"
  );
});

test("MCP root canonicalization returns deduplicated trusted paths", async () => {
  const resolver = async (value) => ({
    canonical_path: "C:\\trusted",
    is_directory: true,
    is_symlink: false,
    is_junction: false,
    is_device: false,
    is_unc: false,
    requested: value,
  });
  const result = await canonicalizeMcpConfig({
    enabled: true,
    profileId: "desktop.default",
    allowedRoots: ["C:\\trusted", "C:/trusted"],
  }, resolver);
  assert.deepEqual(result.allowedRoots, ["C:\\trusted"]);
  assert.equal(result.enabled, true);
  assert.equal(result.profileId, "desktop.default");
});

test("MCP trusted directory resolver rejects an actual Windows junction", { skip: process.platform !== "win32" }, async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "moonshine-mcp-root-"));
  const target = path.join(parent, "target");
  const junction = path.join(parent, "junction");
  try {
    await mkdir(target);
    await symlink(target, junction, "junction");
    assert.equal((await resolveTrustedMcpDirectory(target))?.is_directory, true);
    assert.equal(await resolveTrustedMcpDirectory(junction), null);
  } finally {
    await rm(parent, { recursive: true, force: true, maxRetries: 1 });
  }
});

test("MCP trusted path resolver accepts a real file while directory resolver remains directory-only", async () => {
  const packagePath = path.join(root, "package.json");
  const resolvedFile = await resolveTrustedMcpPath(packagePath);
  assert.equal(resolvedFile?.is_file, true);
  assert.equal(resolvedFile?.is_directory, false);
  assert.equal(path.resolve(resolvedFile.canonical_path), packagePath);
  assert.equal(await resolveTrustedMcpDirectory(packagePath), null);
});
