import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { McpProcessManager } from "../../src-electron/mcp-process-manager.js";

const policy = (overrides = {}) => ({
  enabled: true,
  profileId: "desktop-default",
  allowedTools: ["moonshine.capabilities"],
  allowedRoots: ["C:\\trusted"],
  confirmationRequired: true,
  ...overrides,
});

class FakeBridge {
  constructor() {
    this.isRunning = false;
    this.nextCursor = 1;
    this.startCalls = [];
    this.stopCalls = 0;
  }

  async start(options) {
    this.startCalls.push(options);
    this.isRunning = true;
    return {
      endpoint: { host: "127.0.0.1", port: 43123 },
      profile: options.profile,
      policy_snapshot_id: "pol_test",
      allowed_tools: options.allowedTools,
    };
  }

  async stop() {
    this.stopCalls += 1;
    this.isRunning = false;
  }
}

function createChild({ message = { type: "moonshine-mcp-ready" }, exitOnKill = true } = {}) {
  const child = new EventEmitter();
  child.bootstrap = null;
  child.killSignals = [];
  child.exitCode = null;
  child.signalCode = null;
  child.send = (payload, callback) => {
    child.bootstrap = payload;
    callback?.(null);
    queueMicrotask(() => child.emit("message", message));
    return true;
  };
  child.kill = (signal = "SIGTERM") => {
    child.killSignals.push(signal);
    if (child.exitCode !== null) return false;
    if (!exitOnKill) return true;
    child.signalCode = "SIGTERM";
    queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
    return true;
  };
  queueMicrotask(() => child.emit("message", message));
  return child;
}

async function createManager(options = {}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "moonshine-mcp-lifecycle-"));
  const bridge = options.bridge || new FakeBridge();
  const spawns = [];
  const manager = new McpProcessManager({
    bridge,
    adapterScript: path.resolve("src-electron/mcp-stdio-server.mjs"),
    tempRoot,
    baseEnv: { PATH: process.env.PATH || "" },
    readyTimeoutMs: 100,
    stopTimeoutMs: 100,
    random: (size) => Buffer.alloc(size, 7),
    spawn: (_execPath, args, options) => {
      spawns.push({ args, options });
      return options.createChild ? options.createChild() : createChild();
    },
    ...options,
  });
  return { manager, bridge, spawns, tempRoot };
}

test("MCP manager starts one adapter with an in-memory token and removes its private descriptor on stop", async () => {
  const { manager, bridge, spawns, tempRoot } = await createManager();
  try {
    const state = await manager.sync(policy());
    assert.deepEqual(state, {
      enabled: true,
      running: true,
      status: "running",
      error_code: null,
      allowed_tools: ["moonshine.capabilities"],
      activity_cursor: 0,
    });
    assert.equal(bridge.startCalls.length, 1);
    assert.match(bridge.startCalls[0].token, /^[a-f0-9]{64}$/);
    assert.equal(spawns.length, 1);
    assert.deepEqual(spawns[0].args, [path.resolve("src-electron/mcp-stdio-server.mjs")]);
    assert.equal(spawns[0].options.windowsHide, true);
    assert.deepEqual(spawns[0].options.stdio, ["pipe", "pipe", "pipe", "ipc"]);
    assert.equal(spawns[0].options.env.MOONSHINE_MCP_CONTROLLED, "1");
    assert.equal(Object.hasOwn(spawns[0].options.env, "MOONSHINE_MCP_TOKEN"), false);
    assert.equal(Object.hasOwn(spawns[0].options.env, "MOONSHINE_MCP_DESCRIPTOR_PATH"), false);

    const descriptors = await readdir(tempRoot);
    assert.equal(descriptors.length, 1);
    const descriptorContent = await readFile(path.join(tempRoot, descriptors[0]), "utf8");
    assert.doesNotMatch(descriptorContent, new RegExp(bridge.startCalls[0].token));
    assert.doesNotMatch(JSON.stringify(manager.getState()), /descriptor|token|trusted/i);

    await manager.stop({ preservePolicy: true });
    assert.deepEqual(await readdir(tempRoot), []);
    assert.equal(bridge.isRunning, false);
    assert.equal(manager.getState().status, "stopped");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("MCP manager coalesces duplicate start and rolls back bridge state after an adapter readiness failure", async () => {
  const bridge = new FakeBridge();
  const { manager, spawns, tempRoot } = await createManager({
    bridge,
    spawn: (_execPath, args, options) => {
      spawns.push({ args, options });
      return createChild({ message: { type: "moonshine-mcp-failed", code: "MCP_BRIDGE_UNAVAILABLE" } });
    },
  });
  try {
    await assert.rejects(
      () => manager.sync(policy()),
      (error) => error?.code === "MCP_BRIDGE_UNAVAILABLE",
    );
    assert.equal(bridge.isRunning, false);
    assert.equal(manager.getState().status, "failed");
    assert.equal(manager.getState().error_code, "MCP_BRIDGE_UNAVAILABLE");
    assert.deepEqual(await readdir(tempRoot), []);
    assert.equal(spawns.length, 1);

    const running = await createManager();
    try {
      await Promise.all([running.manager.sync(policy()), running.manager.sync(policy())]);
      assert.equal(running.spawns.length, 1);
    } finally {
      await running.manager.stop({ preservePolicy: true });
      await rm(running.tempRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("MCP manager fails closed without spawning an adapter when an enabled policy is incomplete", async () => {
  const { manager, bridge, spawns, tempRoot } = await createManager();
  try {
    const toolState = await manager.sync(policy({ allowedTools: [] }));
    assert.equal(toolState.status, "failed");
    assert.equal(toolState.error_code, "MCP_ALLOWED_TOOL_REQUIRED");
    assert.equal(toolState.running, false);
    assert.equal(bridge.isRunning, false);
    assert.equal(spawns.length, 0);

    const rootState = await manager.sync(policy({ allowedRoots: [] }));
    assert.equal(rootState.status, "failed");
    assert.equal(rootState.error_code, "MCP_ALLOWED_ROOT_REQUIRED");
    assert.equal(spawns.length, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("unexpected adapter exit revokes bridge access and exposes only a safe failure code", async () => {
  let child = null;
  const { manager, bridge, tempRoot } = await createManager({
    spawn: () => {
      child = createChild();
      return child;
    },
  });
  try {
    await manager.sync(policy());
    child.emit("exit", 1, null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(manager.getState().running, false);
    assert.equal(manager.getState().status, "failed");
    assert.equal(manager.getState().error_code, "MCP_ADAPTER_EXITED");
    assert.equal(bridge.isRunning, false);
    assert.doesNotMatch(JSON.stringify(manager.getState()), /token|descriptor/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("MCP stop force-kills a non-responsive adapter and ignores its late exit", async () => {
  let child = null;
  const { manager, bridge, tempRoot } = await createManager({
    stopTimeoutMs: 10,
    spawn: () => {
      child = createChild({ exitOnKill: false });
      return child;
    },
  });
  try {
    await manager.sync(policy());
    await manager.stop({ preservePolicy: true });
    assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
    assert.equal(bridge.isRunning, false);
    assert.equal(manager.getState().status, "stopped");
    child.emit("exit", 0, "SIGKILL");
    child.emit("error", new Error("late child error"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(manager.getState().status, "stopped");
    assert.equal(manager.getState().running, false);
    assert.equal(manager.getState().error_code, null);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("fatal startup handling awaits MCP stop before direct app exit", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const source = await readFile(path.join(root, "src-electron", "electron-main.js"), "utf8");
  const handlerStart = source.indexOf("const handleFatalStartupError =");
  const handlerEnd = source.indexOf("process.on(\"uncaughtException\"", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);
  const stopIndex = handler.indexOf("await mcpProcessManager.stop({ preservePolicy: true });");
  const exitIndex = handler.indexOf("app.exit(");
  assert.ok(stopIndex >= 0);
  assert.ok(exitIndex > stopIndex);
});
