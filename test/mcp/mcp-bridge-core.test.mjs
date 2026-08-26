import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { McpBridge, MCP_PROTOCOL_VERSION } from "../../src-electron/mcp-bridge.js";
import { resolveTrustedMcpPath } from "../../src-electron/mcp-config.js";

const DEFAULT_CLIENT_ID = "mcp-test-client";

function trustedPath(canonicalPath, overrides = {}) {
  return {
    canonical_path: canonicalPath,
    is_device: false,
    is_junction: false,
    is_symlink: false,
    is_unc: false,
    is_file: true,
    ...overrides,
  };
}

async function trustedResolver(candidate) {
  return trustedPath(candidate);
}

function callSequence(endpoint, messages) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const responses = [];
    let pending = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("bridge response timeout"));
    }, 3000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`));
    socket.on("data", (chunk) => {
      pending += chunk;
      let boundary = pending.indexOf("\n");
      while (boundary !== -1) {
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        boundary = pending.indexOf("\n");
        if (line) responses.push(JSON.parse(line));
      }
      if (responses.length === messages.length) socket.end();
    });
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timer);
      if (responses.length === messages.length) resolve(responses);
      else reject(new Error(`expected ${messages.length} responses, received ${responses.length}`));
    });
  });
}

function request(id, method, params = {}) {
  return { jsonrpc: "2.0", id, method, params };
}

function handshake(id, token, clientId = DEFAULT_CLIENT_ID) {
  return request(id, "bridge.handshake", {
    client_id: clientId,
    profile: "desktop-default",
    protocol_version: MCP_PROTOCOL_VERSION,
    token,
  });
}

function workspaceSubmitParams(descriptor, overrides = {}) {
  return {
    tool: "moonshine.image.process_batch",
    workspace_id: descriptor.workspace_ids[0],
    items: [{ id: "itm_abcdefgh", input_path: "a.png", mask_path: "a.mask.png" }],
    client_id: DEFAULT_CLIENT_ID,
    request_id: "req_abcdefgh",
    idempotency_key: "batch-key-001",
    policy_snapshot_id: descriptor.policy_snapshot_id,
    confirmation: {
      policy_snapshot_id: descriptor.policy_snapshot_id,
      mode: "not_required",
    },
    ...overrides,
  };
}

function expectError(response, id, code) {
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, id);
  assert.equal(response.error?.code, code);
}

async function authenticatedCalls(endpoint, token, messages, clientId = DEFAULT_CLIENT_ID) {
  const responses = await callSequence(endpoint, [handshake(1, token, clientId), ...messages]);
  assert.ok(responses[0].result, "authenticated call requires a successful handshake");
  return responses.slice(1);
}

function sendUnterminatedFrame(endpoint, frame) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const responses = [];
    let pending = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("bridge oversized frame timeout"));
    }, 3000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(frame));
    socket.on("data", (chunk) => {
      pending += chunk;
      let boundary = pending.indexOf("\n");
      while (boundary !== -1) {
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        boundary = pending.indexOf("\n");
        if (line) responses.push(JSON.parse(line));
      }
    });
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(responses);
    });
  });
}

function openAuthenticatedSocket(endpoint, token) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let pending = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(handshake(1, token))}\n`));
    socket.on("data", (chunk) => {
      pending += chunk;
      const boundary = pending.indexOf("\n");
      if (boundary === -1) return;
      const response = JSON.parse(pending.slice(0, boundary));
      if (response.result) resolve(socket);
      else reject(new Error(`handshake failed: ${response.error?.code}`));
    });
    socket.on("error", reject);
  });
}

test("McpBridge is disabled by default and never discloses its configured token", async () => {
  const token = "mcp-secret-token";
  const bridge = new McpBridge({ resolvePath: trustedResolver });
  assert.deepEqual(await bridge.start(), { enabled: false, running: false });
  assert.equal(bridge.isRunning, false);

  const descriptor = await bridge.start({
    enabled: true,
    profile: "desktop-default",
    token,
    allowedRoots: ["C:/moonshine/inputs"],
  });
  try {
    assert.equal(descriptor.endpoint.host, "127.0.0.1");
    assert.equal(Number.isInteger(descriptor.endpoint.port), true);
    assert.equal(Object.hasOwn(descriptor, "token"), false);
    assert.doesNotMatch(JSON.stringify(descriptor), new RegExp(token));
  } finally {
    await bridge.stop();
  }
});

test("McpBridge reports actionable policy errors before starting a service", async () => {
  const bridge = new McpBridge({ resolvePath: trustedResolver });

  await assert.rejects(
    () => bridge.start({
      enabled: true,
      profile: "desktop-default",
      token: "mcp-secret-token",
      allowedRoots: [],
      allowedTools: ["moonshine.capabilities"],
    }),
    (error) => error?.code === "MCP_ALLOWED_ROOT_REQUIRED",
  );

  await assert.rejects(
    () => bridge.start({
      enabled: true,
      profile: "desktop-default",
      token: "mcp-secret-token",
      allowedRoots: ["C:/moonshine/inputs"],
      allowedTools: [],
    }),
    (error) => error?.code === "MCP_ALLOWED_TOOL_REQUIRED",
  );
});

test("McpBridge auto-approve binds canonical paths to policy and client without per-request confirmation", async () => {
  const token = "mcp-secret-token";
  const received = [];
  const bridge = new McpBridge({
    dispatch: async (payload) => {
      received.push(payload);
      return {
        artifact_ids: ["artifact_12345678"],
        job_id: "job_12345678",
        output_path: "C:/private/result.png",
        status: "queued",
        token: "dispatch-secret",
      };
    },
    now: () => "2026-08-16T00:00:00Z",
    resolvePath: trustedResolver,
  });
  const descriptor = await bridge.start({
    enabled: true,
    confirmationMode: "auto_approve",
    profile: "desktop-default",
    token,
    allowedRoots: ["C:/moonshine/inputs"],
  });
  try {
    const responses = await callSequence(descriptor.endpoint, [
      request(1, "bridge.call", { tool: "moonshine.capabilities" }),
      handshake(2, "wrong-token"),
      request(3, "bridge.handshake", { client_id: DEFAULT_CLIENT_ID, protocol_version: MCP_PROTOCOL_VERSION, token, profile: "other-profile" }),
      handshake(4, token),
      request(5, "bridge.call", { tool: "moonshine.not-allowed" }),
      request(6, "bridge.call", { tool: "moonshine.image.process_batch", input_paths: ["C:/moonshine/outside/a.png"] }),
      request("caller-secret-request-id", "bridge.call", { tool: "moonshine.image.process_batch", input_paths: ["C:/moonshine/inputs/a.png"] }),
      request(8, "bridge.call", { tool: "moonshine.jobs.get", job_id: "short" }),
      request(9, "bridge.call", { tool: "moonshine.jobs.get", job_id: "job_12345678" }),
    ]);

    const byId = new Map(responses.map((response) => [response.id, response]));
    expectError(byId.get(1), 1, "AUTH_REQUIRED");
    expectError(byId.get(2), 2, "AUTH_DENIED");
    expectError(byId.get(3), 3, "PROFILE_DENIED");
    assert.equal(byId.get(4).result.policy_snapshot_id, descriptor.policy_snapshot_id);
    expectError(byId.get(5), 5, "TOOL_NOT_ALLOWED");
    expectError(byId.get(6), 6, "PATH_NOT_ALLOWED");
    assert.deepEqual(byId.get("caller-secret-request-id").result, { artifact_ids: ["artifact_12345678"], job_id: "job_12345678", status: "queued" });
    expectError(byId.get(8), 8, "INVALID_JOB_ID");
    assert.deepEqual(byId.get(9).result, { artifact_ids: ["artifact_12345678"], job_id: "job_12345678", status: "queued" });
    assert.equal(received.length, 2);
    assert.deepEqual(received[0].policy.allowedRoots, ["C:\\moonshine\\inputs"]);
    const writeDispatch = received.find((entry) => entry.tool === "moonshine.image.process_batch");
    assert.ok(writeDispatch, JSON.stringify(received));
    assert.deepEqual(writeDispatch.params.input_paths, [path.resolve("C:/moonshine/inputs/a.png")]);
    assert.equal(Object.hasOwn(writeDispatch.params, "confirmation_id"), false);

    const activity = bridge.getActivity();
    assert.equal(activity.length, 5);
    const activityText = JSON.stringify(activity);
    assert.equal(activityText.includes("caller-secret-request-id"), false);
    assert.equal(activityText.includes(token), false);
    assert.equal(activityText.includes("C:/moonshine/inputs/a.png"), false);
    assert.equal(activity.at(-1).outcome, "accepted");
  } finally {
    await bridge.stop();
  }
});

test("McpBridge canonicalizes every supported path field and rejects unsafe resolver metadata", async () => {
  const token = "mcp-secret-token";
  const dispatched = [];
  const bridge = new McpBridge({
    dispatch: async (payload) => {
      dispatched.push(payload);
      return { job_id: "job_12345678" };
    },
    resolvePath: async (candidate) => {
      if (candidate.includes("symlink")) return trustedPath("C:/moonshine/inputs/a.png", { is_symlink: true });
      if (candidate.includes("junction")) return trustedPath("C:/moonshine/inputs/a.png", { is_junction: true });
      if (candidate.includes("device")) return trustedPath("C:/moonshine/inputs/a.png", { is_device: true });
      if (candidate.includes("unc")) return trustedPath("C:/moonshine/inputs/a.png", { is_unc: true });
      if (candidate.includes("string-resolver")) return "C:/moonshine/inputs/a.png";
      return trustedPath(candidate);
    },
  });
  const descriptor = await bridge.start({
    enabled: true,
    confirmationRequired: false,
    profile: "desktop-default",
    token,
    allowedRoots: ["C:/moonshine/inputs"],
  });
  try {
    const responses = await authenticatedCalls(descriptor.endpoint, token, [
      request(2, "bridge.call", {
        input_paths: ["C:/moonshine/inputs/a.png"],
        mask_path: "C:/moonshine/inputs/a.mask.png",
        output_path: "C:/moonshine/inputs/a.output.png",
        sidecar_path: "C:/moonshine/inputs/a.json",
        tool: "moonshine.image.process_batch",
      }),
      request(3, "bridge.call", { input_paths: ["C:/moonshine/inputs/a.png"], output_path: "C:/moonshine/outside/a.png", tool: "moonshine.image.process_batch" }),
      request(4, "bridge.call", { input_paths: ["C:/moonshine/inputs/a.png"], output_paths: ["C:/moonshine/outside/a.png"], tool: "moonshine.image.process_batch" }),
      request(5, "bridge.call", { input_paths: ["C:/moonshine/inputs/a.png"], mask_path: "C:/moonshine/outside/a.png", tool: "moonshine.image.process_batch" }),
      request(6, "bridge.call", { input_paths: ["C:/moonshine/inputs/a.png"], mask_paths: ["C:/moonshine/outside/a.png"], tool: "moonshine.image.process_batch" }),
      request(7, "bridge.call", { input_paths: ["C:/moonshine/inputs/a.png"], sidecar_path: "C:/moonshine/outside/a.json", tool: "moonshine.image.process_batch" }),
      request(8, "bridge.call", { input_paths: ["C:/moonshine/inputs/a.png"], sidecar_paths: ["C:/moonshine/outside/a.json"], tool: "moonshine.image.process_batch" }),
      request(9, "bridge.call", { input_paths: ["C:/moonshine/inputs/a.png"], nested: { sidecar_path: "C:/moonshine/inputs/a.json" }, tool: "moonshine.image.process_batch" }),
      request(10, "bridge.call", { input_paths: ["C:/moonshine/inputs/symlink.png"], tool: "moonshine.image.process_batch" }),
      request(11, "bridge.call", { input_paths: ["C:/moonshine/inputs/junction.png"], tool: "moonshine.image.process_batch" }),
      request(12, "bridge.call", { input_paths: ["C:/moonshine/inputs/device.png"], tool: "moonshine.image.process_batch" }),
      request(13, "bridge.call", { input_paths: ["C:/moonshine/inputs/unc.png"], tool: "moonshine.image.process_batch" }),
      request(14, "bridge.call", { input_paths: ["C:/moonshine/inputs/string-resolver.png"], tool: "moonshine.image.process_batch" }),
      request(15, "bridge.call", { input_paths: ["//server/share/a.png"], tool: "moonshine.image.process_batch" }),
      request(16, "bridge.call", { input_paths: ["C:/moonshine/inputs/a.png"], OUTPUT_PATH: "C:/moonshine/outside/a.png", tool: "moonshine.image.process_batch" }),
      request(17, "bridge.call", { input_paths: ["C:/moonshine/inputs/a.png"], outputPath: "C:/moonshine/outside/a.png", tool: "moonshine.image.process_batch" }),
      request(18, "bridge.call", { input_paths: ["C:/moonshine/inputs/a.png"], resultpath: "C:/moonshine/outside/a.png", tool: "moonshine.image.process_batch" }),
    ]);
    const byId = new Map(responses.map((response) => [response.id, response]));
    assert.deepEqual(byId.get(2).result, { job_id: "job_12345678" });
    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0].params, {
      input_paths: [path.resolve("C:/moonshine/inputs/a.png")],
      mask_path: path.resolve("C:/moonshine/inputs/a.mask.png"),
      output_path: path.resolve("C:/moonshine/inputs/a.output.png"),
      sidecar_path: path.resolve("C:/moonshine/inputs/a.json"),
    });
    for (let id = 3; id <= 18; id += 1) expectError(byId.get(id), id, "PATH_NOT_ALLOWED");
  } finally {
    await bridge.stop();
  }
});

test("McpBridge read-only mode permits trusted OCR detection and rejects write tools", async () => {
  const token = "mcp-secret-token";
  const dispatched = [];
  const bridge = new McpBridge({
    dispatch: async (payload) => {
      dispatched.push(payload);
      return payload.tool === "moonshine.ocr.detect"
        ? {
            candidates: [{ id: "region_12345678", confidence: 0.97, text: "Moonshine", polygon: [[0, 0]], input_path: "C:/private/a.png" }],
            input_path: "C:/private/a.png",
            token: "must-not-project",
          }
        : { job_id: "job_12345678" };
    },
    resolvePath: trustedResolver,
  });
  const descriptor = await bridge.start({
    enabled: true,
    profile: "desktop-default",
    token,
    allowedRoots: ["C:/moonshine/inputs"],
  });
  try {
    const responses = await authenticatedCalls(descriptor.endpoint, token, [
      request(2, "bridge.call", { input_path: "C:/moonshine/inputs/a.png", tool: "moonshine.ocr.detect" }),
      request(3, "bridge.call", { input_paths: ["C:/moonshine/inputs/a.png"], tool: "moonshine.image.process_batch" }),
    ]);
    const byId = new Map(responses.map((response) => [response.id, response]));
    assert.ok(byId.get(2).result, JSON.stringify(byId.get(2)));
    assert.deepEqual(byId.get(2).result, {
      candidates: [{ id: "region_12345678", confidence: 0.97, text: "Moonshine" }],
    });
    expectError(byId.get(3), 3, "POLICY_DENIED");
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].tool, "moonshine.ocr.detect");
    assert.deepEqual(dispatched[0].params, { input_path: path.resolve("C:/moonshine/inputs/a.png") });
    const resultText = JSON.stringify(byId.get(2).result);
    assert.equal(resultText.includes("C:/private"), false);
    assert.equal(resultText.includes("must-not-project"), false);
  } finally {
    await bridge.stop();
  }
});

test("McpBridge auto-approve dispatches a trusted workspace write without per-request approval", async () => {
  const token = "mcp-secret-token";
  const dispatched = [];
  const bridge = new McpBridge({
    dispatch: async (payload) => {
      dispatched.push(payload);
      return { job_id: "job_12345678", status: "queued" };
    },
    resolvePath: trustedResolver,
  });
  const descriptor = await bridge.start({
    enabled: true,
    confirmationMode: "auto_approve",
    profile: "desktop-default",
    token,
    allowedRoots: ["C:/moonshine/inputs"],
  });
  try {
    const [accepted] = await authenticatedCalls(descriptor.endpoint, token, [
      request(2, "bridge.call", workspaceSubmitParams(descriptor)),
    ]);
    assert.deepEqual(accepted.result, { job_id: "job_12345678", status: "queued" });
    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0].params.confirmation, {
      policy_snapshot_id: descriptor.policy_snapshot_id,
      mode: "not_required",
    });
  } finally {
    await bridge.stop();
  }
});

test("McpBridge real trusted resolver accepts workspace files and reaches dispatch", async () => {
  const token = "mcp-secret-token";
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "moonshine-mcp-real-"));
  const inputPath = path.join(workspaceRoot, "input.png");
  const devicePath = path.join(workspaceRoot, "device.png");
  const nestedDirectory = path.join(workspaceRoot, "nested");
  const outsidePath = path.join(path.dirname(workspaceRoot), "outside.png");
  const symlinkPath = path.join(workspaceRoot, "linked.png");
  await writeFile(inputPath, "fixture", "utf8");
  await writeFile(devicePath, "device-fixture", "utf8");
  await writeFile(outsidePath, "outside", "utf8");
  await mkdir(nestedDirectory);
  let symlinkCreated = false;
  try {
    await symlink(inputPath, symlinkPath, "file");
    symlinkCreated = true;
  } catch {
    // Windows may deny symlink creation without developer mode; the direct
    // non-file and traversal checks below remain deterministic.
  }
  const dispatched = [];
  const bridge = new McpBridge({
    dispatch: async (payload) => {
      dispatched.push(payload);
      return { job_id: "job_12345678", status: "queued" };
    },
    resolvePath: async (candidate) => {
      const resolved = await resolveTrustedMcpPath(candidate);
      return resolved && path.resolve(candidate) === devicePath
        ? { ...resolved, is_device: true }
        : resolved;
    },
  });
  try {
    const descriptor = await bridge.start({
      enabled: true,
      confirmationRequired: false,
      profile: "desktop-default",
      token,
      allowedRoots: [workspaceRoot],
    });
    const responses = await authenticatedCalls(descriptor.endpoint, token, [
      request(2, "bridge.call", {
        ...workspaceSubmitParams(descriptor),
        items: [{ id: "itm_abcdefgh", input_path: "input.png", mask_path: "input.png" }],
      }),
      request(3, "bridge.call", {
        ...workspaceSubmitParams(descriptor),
        items: [{ id: "itm_bcdefghi", input_path: "nested", mask_path: "input.png" }],
      }),
      request(4, "bridge.call", {
        ...workspaceSubmitParams(descriptor),
        items: [{ id: "itm_cdefghij", input_path: "../outside.png", mask_path: "input.png" }],
      }),
      request(5, "bridge.call", {
        ...workspaceSubmitParams(descriptor),
        items: [{ id: "itm_defghijk", input_path: "device.png", mask_path: "input.png" }],
      }),
      ...(symlinkCreated ? [request(6, "bridge.call", {
        ...workspaceSubmitParams(descriptor),
        items: [{ id: "itm_efghijkl", input_path: "linked.png", mask_path: "input.png" }],
      })] : []),
    ]);
    const byId = new Map(responses.map((response) => [response.id, response]));
    assert.deepEqual(byId.get(2).result, { job_id: "job_12345678", status: "queued" });
    assert.equal(byId.get(3).error?.code, "PATH_NOT_ALLOWED");
    assert.equal(byId.get(4).error?.code, "PATH_NOT_ALLOWED");
    assert.equal(byId.get(5).error?.code, "PATH_NOT_ALLOWED");
    if (symlinkCreated) assert.equal(byId.get(6).error?.code, "PATH_NOT_ALLOWED");
    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0].params.items, [{ id: "itm_abcdefgh", input_path: "input.png", mask_path: "input.png" }]);
  } finally {
    await bridge.stop();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsidePath, { force: true });
  }
});

test("McpBridge rejects a drifted workspace policy snapshot before dispatch", async () => {
  const token = "mcp-secret-token";
  const dispatched = [];
  const bridge = new McpBridge({
    dispatch: async (payload) => {
      dispatched.push(payload);
      return { job_id: "job_12345678" };
    },
    resolvePath: trustedResolver,
  });
  const descriptor = await bridge.start({
    enabled: true,
    confirmationMode: "auto_approve",
    profile: "desktop-default",
    token,
    allowedRoots: ["C:/moonshine/inputs"],
  });
  try {
    const stalePolicyId = "pol_stale0000";
    const [response] = await authenticatedCalls(descriptor.endpoint, token, [
      request(2, "bridge.call", workspaceSubmitParams(descriptor, {
        policy_snapshot_id: stalePolicyId,
        confirmation: { policy_snapshot_id: stalePolicyId, mode: "not_required" },
      })),
    ]);
    expectError(response, 2, "POLICY_REVOKED");
    assert.equal(dispatched.length, 0);
  } finally {
    await bridge.stop();
  }
});

test("McpBridge full-access bypasses directory checks but retains tool allowlisting and safe projection", async () => {
  const token = "mcp-secret-token";
  const dispatched = [];
  let resolverCalls = 0;
  const bridge = new McpBridge({
    dispatch: async (payload) => {
      dispatched.push(payload);
      return { job_id: "job_12345678", status: "queued", output_path: "C:/outside/result.png", token: "must-not-project" };
    },
    resolvePath: async (candidate) => {
      resolverCalls += 1;
      return trustedResolver(candidate);
    },
  });
  const descriptor = await bridge.start({
    enabled: true,
    confirmationMode: "full_access",
    profile: "desktop-default",
    token,
    allowedRoots: ["C:/moonshine/inputs"],
  });
  const resolverCallsAfterStart = resolverCalls;
  try {
    const responses = await authenticatedCalls(descriptor.endpoint, token, [
      request(2, "bridge.call", {
        confirmation: { token: "discard-me" },
        input_paths: ["D:/outside/a.png"],
        output_path: "D:/outside/result.png",
        tool: "moonshine.image.process_batch",
      }),
      request(3, "bridge.call", { tool: "moonshine.not-allowed" }),
    ]);
    const byId = new Map(responses.map((response) => [response.id, response]));
    assert.ok(byId.get(2).result, JSON.stringify(byId.get(2)));
    assert.deepEqual(byId.get(2).result, { job_id: "job_12345678", status: "queued" });
    expectError(byId.get(3), 3, "TOOL_NOT_ALLOWED");
    assert.equal(resolverCalls, resolverCallsAfterStart);
    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0].params, {
      input_paths: ["D:/outside/a.png"],
      output_path: "D:/outside/result.png",
    });
    assert.equal(JSON.stringify(byId.get(2)).includes("D:/outside"), false);
    assert.equal(JSON.stringify(byId.get(2)).includes("must-not-project"), false);
  } finally {
    await bridge.stop();
  }
});

test("McpBridge bounds unterminated frames and normalizes invalid activity limits", async () => {
  const token = "mcp-secret-token";
  const bridge = new McpBridge({
    dispatch: async (payload) => ({ job_id: payload.params.job_id }),
    maxActivity: Number.NaN,
    maxFrameBytes: 512,
    resolvePath: trustedResolver,
  });
  const descriptor = await bridge.start({
    enabled: true,
    confirmationRequired: false,
    profile: "desktop-default",
    token,
    allowedRoots: ["C:/moonshine/inputs"],
  });
  try {
    const oversized = await sendUnterminatedFrame(descriptor.endpoint, "x".repeat(513));
    assert.equal(oversized.length, 1);
    expectError(oversized[0], null, "REQUEST_TOO_LARGE");

    const requests = Array.from({ length: 201 }, (_, index) => request(index + 2, "bridge.call", {
      job_id: `job_${String(index).padStart(8, "0")}`,
      tool: "moonshine.jobs.get",
    }));
    const responses = await authenticatedCalls(descriptor.endpoint, token, requests);
    assert.equal(responses.length, requests.length);
    assert.equal(bridge.getActivity().length, 200);
  } finally {
    await bridge.stop();
  }
});

test("McpBridge maps internal failures to stable public errors without leaking diagnostics", async () => {
  const secret = "C:/private/secret.png";
  const bridge = new McpBridge({
    dispatch: async () => {
      const error = new Error(secret);
      error.code = "INTERNAL_FAILURE";
      throw error;
    },
    resolvePath: trustedResolver,
  });
  const descriptor = await bridge.start({
    enabled: true,
    profile: "desktop-default",
    token: "mcp-secret-token",
    allowedRoots: ["C:/moonshine/inputs"],
  });
  try {
    const responses = await callSequence(descriptor.endpoint, [
      handshake(1, "mcp-secret-token"),
      request(2, "bridge.call", { tool: "moonshine.jobs.cancel", job_id: "job_12345678" }),
    ]);
    expectError(responses[1], 2, "APP_NOT_RUNNING");
    assert.doesNotMatch(JSON.stringify(responses), new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(bridge.getActivity()), new RegExp(secret));
  } finally {
    await bridge.stop();
  }
});

test("McpBridge stop closes authenticated sockets without retaining a live policy", async () => {
  const bridge = new McpBridge({ resolvePath: trustedResolver });
  const descriptor = await bridge.start({
    enabled: true,
    profile: "desktop-default",
    token: "mcp-secret-token",
    allowedRoots: ["C:/moonshine/inputs"],
  });
  const socket = await openAuthenticatedSocket(descriptor.endpoint, "mcp-secret-token");
  const closed = new Promise((resolve) => socket.once("close", resolve));
  await bridge.stop();
  await closed;
  assert.equal(bridge.isRunning, false);
  assert.deepEqual(bridge.descriptor(), { enabled: false, running: false });
});
