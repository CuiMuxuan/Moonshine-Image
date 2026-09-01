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
  assert.match(source, /getMcpClientConfiguration:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("mcp-get-client-configuration"\)/);
  assert.match(source, /probeMcpExternalProxy:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("mcp-probe-external-proxy"\)/);
  assert.match(source, /getMcpClientSessions:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("mcp-get-client-sessions"\)/);
  assert.match(source, /disconnectMcpClient:\s*\(sessionId\)\s*=>\s*ipcRenderer\.invoke\("mcp-disconnect-client", sessionId\)/);
  assert.match(source, /getMcpApprovals:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("mcp-get-approvals"\)/);
  assert.match(source, /resolveMcpApproval:\s*\(approvalId, decision\)/);
  assert.match(source, /openMcpArtifactInEditor:\s*\(jobId, artifactId\)/);
  assert.doesNotMatch(source, /startMcp|stopMcp|mcp-start|mcp-stop/);
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
  api.ipcRenderer.on("backend-service-state", listener);
  api.ipcRenderer.removeListener("backend-service-state", listener);

  assert.deepEqual(calls.map(({ method, channel }) => ({ method, channel })), [
    { method: "invoke", channel: "get-app-config" },
    { method: "send", channel: "set-active-processing-task" },
    { method: "on", channel: "backend-output" },
    { method: "removeListener", channel: "backend-output" },
    { method: "on", channel: "backend-service-state" },
    { method: "removeListener", channel: "backend-service-state" },
  ]);
  assert.throws(() => api.ipcRenderer.invoke("arbitrary-channel"), /not allowlisted/);
  assert.throws(() => api.ipcRenderer.invoke("execute-command", { command: "echo blocked" }), /not allowlisted/);
  assert.throws(() => api.ipcRenderer.send("arbitrary-channel"), /not allowlisted/);
  assert.throws(() => api.ipcRenderer.on("arbitrary-channel", listener), /not allowlisted/);
  assert.throws(() => api.ipcRenderer.removeListener("arbitrary-channel", listener), /not allowlisted/);
  let receivedEventArgs = null;
  api.ipcRenderer.on("backend-service-state", (...args) => {
    receivedEventArgs = args;
  });
  const registeredHandler = calls
    .filter(({ method, channel }) => method === "on" && channel === "backend-service-state")
    .at(-1)
    .listener;
  const payload = { state: "running" };
  registeredHandler({ sender: { id: "electron-only" } }, payload);
  assert.deepEqual(receivedEventArgs, [null, payload]);
  await api.ipcRenderer.executeCommand({ command: "echo allowed" });
  assert.equal(api.ipcRenderer.showTrayWindow, undefined);
  assert.equal(api.ipcRenderer.hideTrayWindow, undefined);
  assert.equal(api.ipcRenderer.quitFromTray, undefined);
  assert.deepEqual(calls.at(-1), {
    method: "invoke",
    channel: "execute-command",
    args: [{ command: "echo allowed" }],
  });
  assert.equal(calls.length, 8);
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
    approval: null,
    artifacts: [],
    client_name: null,
    client_version: null,
    cursor: 0,
    file_results: [],
    job_group_id: null,
    job_id: null,
    timestamp: null,
    request_id: null,
    session_id: null,
    status: null,
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
    approval: null,
    artifacts: [],
    client_name: null,
    client_version: null,
    cursor: 1,
    file_results: [],
    job_group_id: null,
    job_id: null,
    timestamp: null,
    request_id: null,
    session_id: null,
    status: null,
    tool: "moonshine.jobs.get",
    outcome: null,
    code: null,
  }]);
});

test("MCP external IPC exposes bounded envelopes without tokens, pipe names, or trusted paths", async () => {
  const handlers = new Map();
  const bridge = {
    descriptor: () => null,
    isRunning: false,
    nextCursor: 1,
    getActivity: () => [],
  };
  const external = {
    getClientConfiguration: () => ({
      available: true,
      protocolVersion: "2025-11-25",
      command: "C:/Program Files/Moonshine Image/Moonshine-Image.exe",
      args: ["resources/mcp/moonshine-mcp-proxy.mjs"],
      env: { ELECTRON_RUN_AS_NODE: "1", INTERNAL_TOKEN: "must-not-project" },
      pipeName: "\\\\.\\pipe\\private",
      trustedRoot: "C:/private/images",
    }),
    probe: () => ({ listening: true, protocol_version: "moonshine-mcp-external-pipe-v1", token: "secret" }),
    getSessions: () => [{
      session_id: "ses_abcdefgh",
      client_id: "codex",
      client_version: "1.0.0",
      connected_at: "2026-08-25T01:02:03.000Z",
      status: "connected",
      pipe_name: "\\\\.\\pipe\\private",
    }],
    disconnect: (sessionId) => sessionId === "ses_abcdefgh",
  };
  const dispatcher = {
    listApprovals: () => [{
      approval_id: "apr_abcdefgh",
      client_id: "codex",
      tool: "moonshine.image.process",
      state: "pending",
      expires_at: "2026-08-25T01:12:03.000Z",
      input_path: "C:/private/images/a.png",
    }],
    resolveApproval: ({ approvalId, approved }) => ({
      approval_id: approvalId,
      client_id: "codex",
      tool: "moonshine.image.process",
      state: approved ? "approved" : "rejected",
      expires_at: "2026-08-25T01:12:03.000Z",
    }),
  };
  const opened = [];
  registerMcpIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    bridge,
    external,
    dispatcher,
    openArtifactInEditor: ({ jobId, artifactId }) => {
      opened.push({ jobId, artifactId });
      return true;
    },
  });

  const configuration = await handlers.get(MCP_IPC_CHANNELS.getClientConfiguration)({});
  assert.equal(configuration.success, true);
  assert.equal(configuration.data.available, true);
  assert.deepEqual(configuration.data.args, ["resources/mcp/moonshine-mcp-proxy.mjs"]);
  assert.equal(configuration.data.jsonTemplate.includes("ELECTRON_RUN_AS_NODE"), true);
  assert.equal(configuration.data.jsonTemplate.includes("INTERNAL_TOKEN"), false);
  assert.match(configuration.data.jsonTemplate, /"ELECTRON_RUN_AS_NODE": "1"/);

  assert.deepEqual(await handlers.get(MCP_IPC_CHANNELS.probeExternalProxy)({}), {
    success: true,
    data: { available: true, code: null, protocolVersion: "moonshine-mcp-external-pipe-v1" },
  });
  assert.deepEqual(await handlers.get(MCP_IPC_CHANNELS.getClientSessions)({}), {
    success: true,
    data: [{
      sessionId: "ses_abcdefgh",
      clientName: "codex",
      clientVersion: "1.0.0",
      connectedAt: "2026-08-25T01:02:03.000Z",
      lastSeenAt: null,
      status: "connected",
    }],
  });
  assert.deepEqual(await handlers.get(MCP_IPC_CHANNELS.getApprovals)({}), {
    success: true,
    data: [{
      approvalId: "apr_abcdefgh",
      tool: "moonshine.image.process",
      clientName: "codex",
      jobId: null,
      jobGroupId: null,
      createdAt: null,
      expiresAt: "2026-08-25T01:12:03.000Z",
      status: "pending",
    }],
  });
  assert.deepEqual(await handlers.get(MCP_IPC_CHANNELS.disconnectClient)({}, "ses_abcdefgh"), { success: true });
  const approval = await handlers.get(MCP_IPC_CHANNELS.resolveApproval)({}, "apr_abcdefgh", "approve");
  assert.equal(approval.success, true);
  assert.equal(approval.data.status, "approved");
  assert.deepEqual(
    await handlers.get(MCP_IPC_CHANNELS.openArtifactInEditor)({}, "job_abcdefgh", "art_abcdefgh"),
    { success: true },
  );
  assert.deepEqual(opened, [{ jobId: "job_abcdefgh", artifactId: "art_abcdefgh" }]);

  const projectedText = JSON.stringify({ configuration, sessions: await handlers.get(MCP_IPC_CHANNELS.getClientSessions)({}) });
  assert.equal(projectedText.includes("must-not-project"), false);
  assert.equal(projectedText.includes("C:/private/images"), false);
  assert.equal(projectedText.includes("\\\\.\\pipe"), false);

  external.getClientConfiguration = () => ({
    available: true,
    command: "Moonshine-Image.exe",
    args: ["--pipe", "\\\\.\\pipe\\private"],
  });
  assert.deepEqual(await handlers.get(MCP_IPC_CHANNELS.getClientConfiguration)({}), {
    success: true,
    data: { available: false, protocolVersion: null, command: null, args: [], jsonTemplate: null },
  });
});

test("MCP client configuration always prevents GUI startup when provider env is missing", async () => {
  const handlers = new Map();
  registerMcpIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    bridge: { descriptor: () => null, getActivity: () => [] },
    external: {
      getClientConfiguration: () => ({
        available: true,
        protocolVersion: "2025-11-25",
        command: "C:/Program Files/Moonshine Image/Moonshine-Image.exe",
        args: ["C:/Program Files/Moonshine Image/resources/mcp/moonshine-mcp-proxy.mjs"],
      }),
    },
  });
  const result = await handlers.get(MCP_IPC_CHANNELS.getClientConfiguration)({});
  assert.equal(result.success, true);
  assert.match(result.data.jsonTemplate, /"ELECTRON_RUN_AS_NODE": "1"/);
});

test("Electron main guards against GUI startup for a proxy invocation without headless mode", async () => {
  const source = await readFile(path.join(root, "src-electron", "electron-main.js"), "utf8");
  assert.match(source, /externalProxyInvocation/);
  assert.match(source, /MCP_PROXY_REQUIRES_ELECTRON_RUN_AS_NODE/);
  assert.match(source, /app\.exit\(78\)/);
});
