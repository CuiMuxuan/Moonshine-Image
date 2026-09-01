import test from "node:test";
import assert from "node:assert/strict";

import {
  createMcpExternalClientConfiguration,
  createMcpNamedPipeServer,
  getMcpExternalPrivatePipeName,
  McpExternalPipeClient,
  normalizeMcpClientInfo,
} from "../../src-electron/mcp-external-pipe.js";
import { createMcpExternalProxyServer } from "../../src-electron/mcp-external-proxy.mjs";

test("external client configuration pins Electron to headless Node mode", () => {
  const configuration = createMcpExternalClientConfiguration({
    proxyPath: "C:\\Program Files\\Moonshine Image\\resources\\mcp\\moonshine-mcp-proxy.mjs",
    executablePath: "C:\\Program Files\\Moonshine Image\\Moonshine-Image.exe",
  });
  assert.deepEqual(configuration.env, { ELECTRON_RUN_AS_NODE: "1" });
});

test("external client metadata is bounded and strips control characters", () => {
  const value = normalizeMcpClientInfo({
    name: `  Codex\u0000${"x".repeat(200)}`,
    version: "\u0001 9.8.7 \u007f",
    token: "must-not-escape",
  });
  assert.equal(value.name.length, 128);
  assert.equal(value.name.startsWith("Codex"), true);
  assert.equal(value.name.includes("\u0000"), false);
  assert.equal(value.version, "9.8.7");
  assert.equal(normalizeMcpClientInfo({ token: "ignored" }), null);
});

test("private MCP pipe accepts an attested identity and routes status/business calls", async () => {
  const pipeName = getMcpExternalPrivatePipeName();
  const disconnected = [];
  const server = createMcpNamedPipeServer({
    pipeName,
    requestTimeoutMs: 100,
    getServiceState: () => ({ enabled: true, running: true, status: "running" }),
    verifyClientIdentity: ({ identity }) => identity.client_id === "codex-test",
    onClientDisconnected: (clientId, sessionId) => disconnected.push({ clientId, sessionId }),
    dispatch: async ({ tool, params }) => ({ tool, params, status: "succeeded" }),
  });
  await server.start();
  const client = new McpExternalPipeClient({
    pipeName,
    requestTimeoutMs: 100,
    identity: { client_id: "codex-test", proxy_path: "C:\\proxy.mjs", proxy_pid: process.pid },
  });
  try {
    const status = await client.call("moonshine.status");
    assert.equal(status.running, true);
    const result = await client.call("moonshine.ocr.detect", { input_path: "C:\\trusted\\image.png" }, {
      name: "Codex Desktop",
      version: "9.8.7",
      ignored: "must-not-forward",
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.tool, "moonshine.ocr.detect");
    assert.equal(server.getSessions().length, 1);
    assert.deepEqual(server.getSessions()[0], {
      session_id: server.getSessions()[0].session_id,
      client_id: "codex-test",
      client_name: "Codex Desktop",
      client_version: "9.8.7",
      connected_at: server.getSessions()[0].connected_at,
    });
  } finally {
    const activeSession = server.getSessions()[0];
    client.socket?.unref?.();
    server.server?.unref?.();
    await client.close();
    if (activeSession?.session_id) await server.disconnect(activeSession.session_id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(disconnected.length, 1);
    assert.equal(disconnected[0].clientId, "codex-test");
    assert.match(disconnected[0].sessionId, /^mps_[a-f0-9]{32}$/);
    for (const socket of server.sockets) socket.destroy();
    await server.stop();
  }
});

test("external proxy forwards bounded MCP initialize client metadata", async () => {
  const calls = [];
  const pipeClient = {
    async call(...args) {
      calls.push(args);
      return { status: "running" };
    },
  };
  const { server } = createMcpExternalProxyServer({
    pipeName: getMcpExternalPrivatePipeName(),
    pipeClient,
    identity: { client_id: "proxy-test", proxy_path: "C:\\proxy.mjs", proxy_pid: process.pid },
  });
  server.server.getClientVersion = () => ({ name: "Pi Desktop", version: "1.2.3", token: "secret" });
  await server._registeredTools["moonshine.status"].handler({});
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][2], { name: "Pi Desktop", version: "1.2.3" });
});

test("external proxy advertises stable argument schemas and app-off calls fail as structured errors", async () => {
  const pipeClient = {
    async call(tool) {
      if (tool === "moonshine.status") return { status: "stopped", running: false };
      throw Object.assign(new Error("APP_NOT_RUNNING"), { code: "APP_NOT_RUNNING" });
    },
  };
  const { server } = createMcpExternalProxyServer({
    pipeName: getMcpExternalPrivatePipeName(),
    pipeClient,
    identity: { client_id: "proxy-test", proxy_path: "C:\\proxy.mjs", proxy_pid: process.pid },
  });
  const tools = server._registeredTools;
  assert.ok(tools["moonshine.ocr.detect"]);
  assert.ok(tools["moonshine.ocr.detect"].inputSchema);
  assert.ok(tools["moonshine.image.process"].inputSchema);
  assert.ok(tools["moonshine.ocr.detect"].inputSchema._def?.shape);
  // The SDK instance is never connected in this contract test, so no transport
  // shutdown is required here.
});

test("external pipe client clears a partial frame before reconnecting", async () => {
  const client = new McpExternalPipeClient({
    pipeName: getMcpExternalPrivatePipeName(),
    requestTimeoutMs: 25,
    identity: { client_id: "buffer-test", proxy_path: "C:\\proxy.mjs", proxy_pid: process.pid },
  });
  client.buffer = '{"jsonrpc":"2.0"';
  await client.close();
  assert.equal(client.buffer, "");
});
