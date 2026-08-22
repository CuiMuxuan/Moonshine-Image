import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { MCP_IPC_CHANNELS, createMcpBridge, getMcpState, registerMcpIpc } from "../../src-electron/mcp-ipc.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function evaluatePreload() {
  const source = await readFile(path.join(root, "src-electron", "electron-preload.js"), "utf8");
  const calls = [];
  let exposedApi = null;
  const ipcRenderer = {
    invoke: (channel, ...args) => {
      calls.push({ method: "invoke", channel, args });
      return Promise.resolve({ channel });
    },
    send: (channel, ...args) => calls.push({ method: "send", channel, args }),
    on: (channel, listener) => calls.push({ method: "on", channel, listener }),
    removeListener: (channel, listener) => calls.push({ method: "removeListener", channel, listener }),
  };
  const context = {
    ArrayBuffer,
    Buffer,
    Uint8Array,
    console,
    require: (id) => {
      if (id === "electron") {
        return {
          contextBridge: {
            exposeInMainWorld: (_name, api) => {
              exposedApi = api;
            },
          },
          ipcRenderer,
          webUtils: { getPathForFile: () => "" },
        };
      }
      if (id === "fs") return { promises: {} };
      if (id === "path") return path;
      throw new Error(`Unexpected preload dependency: ${id}`);
    },
  };
  vm.runInNewContext(source, context, { filename: "electron-preload.js" });
  return { api: exposedApi, calls };
}

test("MCP IPC is named, read-only by default, and projects safe activity fields", async () => {
  const bridge = createMcpBridge({ now: () => "2026-08-17T00:00:00.000Z" });
  const handlers = new Map();
  registerMcpIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    bridge,
  });

  assert.deepEqual([...handlers.keys()], Object.values(MCP_IPC_CHANNELS));
  assert.deepEqual(getMcpState(bridge), {
    enabled: false,
    running: false,
    allowed_tools: [],
    activity_cursor: 0,
  });
  assert.deepEqual(await handlers.get(MCP_IPC_CHANNELS.getActivity)({}, 0), []);
  assert.deepEqual(await handlers.get(MCP_IPC_CHANNELS.stop)({}), {
    enabled: false,
    running: false,
    allowed_tools: [],
    activity_cursor: 0,
  });
});

test("MCP preload exposes only fixed named wrappers for this IPC slice", async () => {
  const source = await readFile(path.join(root, "src-electron", "electron-preload.js"), "utf8");
  assert.match(source, /const ALLOWED_INVOKE_CHANNELS = new Set\(\[/);
  assert.match(source, /assertAllowedChannel\(channel, ALLOWED_INVOKE_CHANNELS\)/);
  assert.match(source, /assertAllowedChannel\(channel, ALLOWED_SEND_CHANNELS\)/);
  assert.match(source, /assertAllowedChannel\(channel, ALLOWED_EVENT_CHANNELS\)/);
  assert.doesNotMatch(source, /invoke:\s*\(channel, \.\.\.args\)\s*=>\s*ipcRenderer\.invoke\(channel/);
  assert.match(source, /getMcpState:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("mcp-get-state"\)/);
  assert.match(source, /getMcpActivity:\s*\(after = 0\)\s*=>\s*ipcRenderer\.invoke\("mcp-get-activity", after\)/);
  assert.match(source, /startMcp:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("mcp-start"\)/);
  assert.match(source, /stopMcp:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("mcp-stop"\)/);
  assert.match(source, /executeCommand:\s*\(options\)\s*=>\s*ipcRenderer\.invoke\("execute-command", options\)/);
  assert.doesNotMatch(source, /mcp-(?:configure|set-token)/);
  assert.doesNotMatch(source, /(?:showTrayWindow|hideTrayWindow|quitFromTray):/);
});

test("preload generic IPC methods reject unknown channels before Electron dispatch", async () => {
  const { api, calls } = await evaluatePreload();
  assert.ok(api?.ipcRenderer);

  await api.ipcRenderer.invoke("get-app-config");
  api.ipcRenderer.send("set-active-processing-task", { active: true });
  const listener = () => {};
  api.ipcRenderer.on("backend-output", listener);
  api.ipcRenderer.removeListener("backend-output", listener);

  assert.deepEqual(calls.map(({ method, channel }) => ({ method, channel })), [
    { method: "invoke", channel: "get-app-config" },
    { method: "send", channel: "set-active-processing-task" },
    { method: "on", channel: "backend-output" },
    { method: "removeListener", channel: "backend-output" },
  ]);
  assert.throws(() => api.ipcRenderer.invoke("arbitrary-channel"), /not allowlisted/);
  assert.throws(() => api.ipcRenderer.invoke("execute-command", { command: "echo blocked" }), /not allowlisted/);
  assert.throws(() => api.ipcRenderer.send("arbitrary-channel"), /not allowlisted/);
  assert.throws(() => api.ipcRenderer.on("arbitrary-channel", listener), /not allowlisted/);
  assert.throws(() => api.ipcRenderer.removeListener("arbitrary-channel", listener), /not allowlisted/);
  await api.ipcRenderer.executeCommand({ command: "echo allowed" });
  assert.equal(api.ipcRenderer.showTrayWindow, undefined);
  assert.equal(api.ipcRenderer.hideTrayWindow, undefined);
  assert.equal(api.ipcRenderer.quitFromTray, undefined);
  assert.deepEqual(calls.at(-1), {
    method: "invoke",
    channel: "execute-command",
    args: [{ command: "echo allowed" }],
  });
  assert.equal(calls.length, 5);
});

test("MCP IPC projects hostile activity and descriptor values into bounded fields", async () => {
  const handlers = new Map();
  const bridge = {
    descriptor: () => ({
      enabled: 1,
      allowed_tools: ["moonshine.jobs.get", "not-allowlisted", { tool: "moonshine.ocr.create_masks" }],
    }),
    isRunning: "yes",
    nextCursor: "not-a-number",
    getActivity: () => [{
      cursor: "invalid",
      timestamp: 42,
      request_id: { secret: "token" },
      tool: "not-allowlisted",
      outcome: { path: "C:/private/image.png" },
      code: 500,
      token: "should-not-project",
      path: "C:/private/image.png",
    }],
    stop: async () => {},
  };
  registerMcpIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    bridge,
  });

  assert.deepEqual(getMcpState(bridge), {
    enabled: true,
    running: true,
    allowed_tools: ["moonshine.jobs.get"],
    activity_cursor: 0,
  });
  assert.deepEqual(await handlers.get(MCP_IPC_CHANNELS.getActivity)({}, "invalid"), [{
    cursor: 0,
    timestamp: null,
    request_id: null,
    tool: null,
    outcome: null,
    code: null,
  }]);

  bridge.getActivity = () => [{
    cursor: 1,
    timestamp: "token C:/private/image.png",
    request_id: "C:/private/image.png",
    tool: "moonshine.jobs.get",
    outcome: "secret-token",
    code: "C:/private/image.png",
  }];
  assert.deepEqual(await handlers.get(MCP_IPC_CHANNELS.getActivity)({}, 0), [{
    cursor: 1,
    timestamp: null,
    request_id: null,
    tool: "moonshine.jobs.get",
    outcome: null,
    code: null,
  }]);
});
