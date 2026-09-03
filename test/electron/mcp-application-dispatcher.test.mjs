import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createMcpApplicationDispatcher,
  McpApplicationDispatchError,
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  projectMcpPublicResult,
} from "../../src-electron/mcp-application-dispatcher.js";
import { createMcpApprovalRegistry } from "../../src-electron/mcp-approval-registry.js";

const jobId = "job_12345678";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("MCP application dispatcher maps only safe job routes and strips paths", async () => {
  const requests = [];
  const dispatcher = createMcpApplicationDispatcher({
    request: async (request) => {
      requests.push(request);
      return {
        ok: true,
        status: 200,
        body: {
          job_id: jobId,
          status: "succeeded",
          artifacts: [{ artifact_id: "art_12345678", asset: { media_type: "image/png", size_bytes: 3, relative_path: "C:/secret" } }],
          path: "C:/secret",
        },
      };
    },
  });

  const result = await dispatcher.dispatch({ tool: "moonshine.jobs.result", params: { job_id: jobId } });

  assert.deepEqual(requests, [{ method: "GET", path: `/api/v1/jobs/${jobId}/artifacts` }]);
  assert.deepEqual(result, {
    job_id: jobId,
    status: "succeeded",
    artifacts: [{ artifact_id: "art_12345678", mime_type: "image/png", size_bytes: 3 }],
  });
  assert.equal(Object.hasOwn(result, "path"), false);
});

test("MCP application dispatcher rejects malformed submit requests and unsafe identifiers", async () => {
  const dispatcher = createMcpApplicationDispatcher();
  await assert.rejects(
    dispatcher.dispatch({ tool: "moonshine.jobs.get", params: { job_id: "../private" } }),
    (error) => error instanceof McpApplicationDispatchError && error.code === "INVALID_JOB_ID",
  );
  await assert.rejects(
    dispatcher.dispatch({ tool: "moonshine.image.process_batch", params: { job_id: jobId } }),
    (error) => error instanceof McpApplicationDispatchError && error.code === "INVALID_SUBMIT_REQUEST",
  );
});

test("MCP application dispatcher rejects non-canonical workspace paths and unsupported model selection", async () => {
  const requests = [];
  const dispatcher = createMcpApplicationDispatcher({
    request: async (request) => {
      requests.push(request);
      return { ok: true, status: 202, headers: { "x-moonshine-job-id": jobId }, body: { job_id: jobId, request_id: "req_abcdefgh", status: "queued" } };
    },
  });
  const baseParams = {
    tool: "moonshine.image.process_batch",
    workspace_id: "ws_abcdefgh",
    items: [{ id: "itm_abcdefgh", input_path: "images/a.png", mask_path: "masks/a.png" }],
    client_id: "mcp-client",
    request_id: "req_abcdefgh",
    idempotency_key: "idem-001",
    policy_snapshot_id: "pol_abcdefgh",
    confirmation: { policy_snapshot_id: "pol_abcdefgh", mode: "not_required" },
  };
  const unsafePaths = [
    "../a.png",
    "images/../a.png",
    "./a.png",
    "images//a.png",
    "file:///C:/a.png",
    "https://example.invalid/a.png",
    "C:/a.png",
    "//server/share/a.png",
  ];
  for (const inputPath of unsafePaths) {
    await assert.rejects(
      dispatcher.dispatch({
        tool: "moonshine.image.process_batch",
        policy: { id: "pol_abcdefgh" },
        params: { ...baseParams, items: [{ ...baseParams.items[0], input_path: inputPath }] },
      }),
      (error) => error instanceof McpApplicationDispatchError && error.code === "INVALID_SUBMIT_REQUEST",
    );
  }
  await assert.rejects(
    dispatcher.dispatch({
      tool: "moonshine.image.process_batch",
      policy: { id: "pol_abcdefgh" },
      params: { ...baseParams, items: [{ ...baseParams.items[0], model_id: "lama" }] },
    }),
    (error) => error instanceof McpApplicationDispatchError && error.code === "UNSUPPORTED_TOOL_OR_MODEL",
  );
  assert.deepEqual(requests, []);
});

test("MCP capabilities remain in-memory and do not require an application request", async () => {
  const dispatcher = createMcpApplicationDispatcher();
  assert.deepEqual(
    await dispatcher.dispatch({ tool: "moonshine.capabilities", policy: { allowedTools: ["moonshine.capabilities"] } }),
    {
      tools: TOOL_NAMES,
      allowed_tools: ["moonshine.capabilities"],
      policy: {
        confirmation_mode: "auto_approve",
        allowed_tools: ["moonshine.capabilities"],
      },
    },
  );
});

test("dispatcher exposes one stable complete tool definition surface", () => {
  assert.deepEqual(TOOL_DEFINITIONS.map((definition) => definition.name), TOOL_NAMES);
  assert.deepEqual(TOOL_NAMES, [
    "moonshine.status",
    "moonshine.capabilities",
    "moonshine.models.list",
    "moonshine.ocr.detect",
    "moonshine.masks.generate",
    "moonshine.image.process",
    "moonshine.image.process_batch",
    "moonshine.jobs.get",
    "moonshine.jobs.result",
    "moonshine.jobs.cancel",
    "moonshine.job_groups.get",
    "moonshine.job_groups.cancel",
  ]);
  assert.equal(TOOL_DEFINITIONS.every((definition) => definition.inputSchema?.type === "object"), true);
});

test("SAM mask tool description documents the vision fallback contract", () => {
  const definition = TOOL_DEFINITIONS.find((item) => item.name === "moonshine.masks.generate");
  assert.ok(definition);
  assert.match(definition.description, /vision-capable harness/i);
  assert.match(definition.description, /no expected target/i);
  assert.match(definition.description, /point or box prompt/i);
  assert.match(definition.description, /without vision/i);
  assert.match(definition.description, /successful mask artifact/i);
});

test("read-only policy rejects output and cancellation writes but allows capability reads", async () => {
  const dispatcher = createMcpApplicationDispatcher();
  const policy = { id: "pol_abcdefgh", confirmationMode: "read_only" };
  const capabilities = await dispatcher.dispatch({ tool: "moonshine.capabilities", policy });
  assert.equal(capabilities.policy.confirmation_mode, "read_only");
  await assert.rejects(
    dispatcher.dispatch({
      tool: "moonshine.image.process",
      policy,
      params: {
        workspace_id: "ws_abcdefgh",
        operation: "remove_text",
        item: { id: "itm_abcdefgh", input_path: "images/a.png", mask_path: "masks/a.png" },
      },
    }),
    (error) => error instanceof McpApplicationDispatchError && error.code === "POLICY_READ_ONLY",
  );
  await assert.rejects(
    dispatcher.dispatch({ tool: "moonshine.jobs.cancel", policy, params: { job_id: jobId } }),
    (error) => error instanceof McpApplicationDispatchError && error.code === "POLICY_READ_ONLY",
  );
});

test("OCR task executor receives artifact-only output and public projection strips paths and bytes", async () => {
  const calls = [];
  const dispatcher = createMcpApplicationDispatcher({
    taskExecutor: async (request) => {
      calls.push(request);
      return {
        job_id: jobId,
        status: "succeeded",
        regions: [{ region_id: "txt_12345678", text: "visible", confidence: 0.95, path: "C:/private" }],
        artifacts: [{ artifact_id: "art_12345678", asset: { media_type: "application/json", size_bytes: 19, relative_path: "C:/private/result.json" } }],
        image_base64: "must-not-escape",
      };
    },
  });
  const result = await dispatcher.dispatch({
    tool: "moonshine.ocr.detect",
    policy: { id: "pol_abcdefgh", confirmationMode: "read_only" },
    clientId: "codex",
    clientInfo: { name: "Codex Desktop", version: "9.8.7" },
    params: { input_path: "C:/trusted/a.png", model_id: "ocr_rapid_onnx_mobile" },
  });
  assert.deepEqual(calls[0].output, { directory_name: "Moonshine-Output", overwrite: false, artifact_only: true });
  assert.deepEqual(calls[0].clientInfo, { name: "Codex Desktop", version: "9.8.7" });
  assert.equal(calls[0].policy.confirmationMode, "read_only");
  assert.deepEqual(result, {
    job_id: jobId,
    status: "succeeded",
    artifacts: [{ artifact_id: "art_12345678", mime_type: "application/json", size_bytes: 19 }],
    candidates: [{ id: "txt_12345678", confidence: 0.95, text: "visible" }],
  });
  const projected = projectMcpPublicResult("moonshine.ocr.detect", { ...result, path: "C:/private", image_base64: "must-not-escape" });
  assert.equal(JSON.stringify(projected).includes("C:/private"), false);
  assert.equal(JSON.stringify(projected).includes("must-not-escape"), false);
});

test("batch processing splits at backend limit and returns a bounded job group", async () => {
  let sequence = 0;
  const requests = [];
  const dispatcher = createMcpApplicationDispatcher({
    request: async (request) => {
      requests.push(request);
      sequence += 1;
      const queuedJobId = "job_" + String(sequence).padStart(8, "0");
      return {
        ok: true,
        status: 202,
        headers: { "x-moonshine-job-id": queuedJobId },
        body: { job_id: queuedJobId, request_id: request.headers["X-Moonshine-Request-Id"], status: "queued" },
      };
    },
  });
  const items = Array.from({ length: 101 }, (_, index) => ({
    id: "itm_" + String(index).padStart(8, "0"),
    input_path: "images/" + index + ".png",
    mask_path: "masks/" + index + ".png",
  }));
  const result = await dispatcher.dispatch({
    tool: "moonshine.image.process_batch",
    policy: { id: "pol_abcdefgh", confirmationMode: "auto_approve" },
    clientId: "codex",
    params: { workspace_id: "ws_abcdefgh", operation: "remove_icon", items, idempotency_key: "split-test" },
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => request.body.items.length), [100, 1]);
  assert.match(result.job_group_id, /^grp_[a-z0-9]{32}$/);
  assert.deepEqual(result.child_job_ids, ["job_00000001", "job_00000002"]);
});

test("local task groups use the local provider, enforce owner and policy, and cancel local children", async () => {
  let sequence = 0;
  const requestedRoutes = [];
  const children = new Map();
  const cancellations = [];
  const dispatcher = createMcpApplicationDispatcher({
    request: async (request) => {
      requestedRoutes.push(request);
      return { ok: true, status: 200, body: { job_id: jobId, status: "succeeded" } };
    },
    taskExecutor: async () => {
      sequence += 1;
      const id = "job_local_" + String(sequence).padStart(8, "0");
      children.set(id, { job_id: id, status: "queued" });
      return { job_id: id, status: "queued" };
    },
    jobProvider: {
      get: ({ jobId: requestedJobId, clientId }) => {
        assert.equal(clientId, "codex");
        return children.get(requestedJobId) || null;
      },
      cancel: ({ jobId: requestedJobId, clientId }) => {
        assert.equal(clientId, "codex");
        cancellations.push(requestedJobId);
        const child = children.get(requestedJobId);
        if (child) child.status = "cancelled";
        return child || null;
      },
    },
  });
  const items = Array.from({ length: 1001 }, (_, index) => ({
    id: "itm_local" + String(index).padStart(8, "0"),
    input_path: "images/" + index + ".png",
    mask_path: "masks/" + index + ".png",
  }));
  const policy = { id: "pol_abcdefgh", confirmationMode: "auto_approve" };
  const submitted = await dispatcher.dispatch({
    tool: "moonshine.image.process_batch",
    policy,
    clientId: "codex",
    params: { workspace_id: "ws_abcdefgh", operation: "remove_text", items },
  });
  assert.match(submitted.job_group_id, /^grp_[a-z0-9]{32}$/);
  assert.deepEqual(requestedRoutes, []);

  const state = await dispatcher.dispatch({
    tool: "moonshine.job_groups.get",
    policy,
    clientId: "codex",
    params: { job_group_id: submitted.job_group_id },
  });
  assert.equal(state.status, "queued");
  assert.deepEqual(state.child_jobs.map((child) => child.status), ["queued", "queued"]);
  assert.deepEqual(requestedRoutes, []);

  await assert.rejects(
    dispatcher.dispatch({
      tool: "moonshine.job_groups.get",
      policy,
      clientId: "other-client",
      params: { job_group_id: submitted.job_group_id },
    }),
    (error) => error instanceof McpApplicationDispatchError && error.code === "POLICY_DENIED",
  );
  await assert.rejects(
    dispatcher.dispatch({
      tool: "moonshine.job_groups.get",
      policy: { ...policy, id: "pol_changed" },
      clientId: "codex",
      params: { job_group_id: submitted.job_group_id },
    }),
    (error) => error instanceof McpApplicationDispatchError && error.code === "POLICY_REVOKED",
  );

  const cancelled = await dispatcher.dispatch({
    tool: "moonshine.job_groups.cancel",
    policy,
    clientId: "codex",
    params: { job_group_id: submitted.job_group_id },
  });
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(cancellations, submitted.child_job_ids);
  assert.deepEqual(requestedRoutes, []);
});

test("policy change revokes and cancels locally owned job groups", async () => {
  const cancellations = [];
  let sequence = 0;
  const dispatcher = createMcpApplicationDispatcher({
    taskExecutor: async () => ({ job_id: "job_revoke_" + String(++sequence).padStart(8, "0"), status: "queued" }),
    jobProvider: {
      get: ({ jobId: requestedJobId }) => ({ job_id: requestedJobId, status: "queued" }),
      cancel: ({ jobId: requestedJobId, clientId }) => {
        cancellations.push({ jobId: requestedJobId, clientId });
        return { job_id: requestedJobId, status: "cancelled" };
      },
    },
  });
  const items = Array.from({ length: 1001 }, (_, index) => ({
    id: "itm_revoke" + String(index).padStart(8, "0"),
    input_path: "images/" + index + ".png",
    mask_path: "masks/" + index + ".png",
  }));
  const submitted = await dispatcher.dispatch({
    tool: "moonshine.image.process_batch",
    policy: { id: "pol_abcdefgh", confirmationMode: "auto_approve" },
    clientId: "codex",
    params: { workspace_id: "ws_abcdefgh", operation: "remove_icon", items },
  });

  await dispatcher.onPolicyChanged("pol_changed");
  assert.deepEqual(cancellations, submitted.child_job_ids.map((jobId) => ({ jobId, clientId: "codex" })));
  await assert.rejects(
    dispatcher.dispatch({
      tool: "moonshine.job_groups.get",
      policy: { id: "pol_changed", confirmationMode: "auto_approve" },
      clientId: "codex",
      params: { job_group_id: submitted.job_group_id },
    }),
    (error) => error instanceof McpApplicationDispatchError && error.code === "POLICY_REVOKED",
  );
});

test("approval lifecycle is safe, client-scoped, recoverable, and expires without recursive sweeping", () => {
  let now = 1_000;
  const approvals = createMcpApprovalRegistry({ ttlMs: 10_000, nowMs: () => now });
  const pending = approvals.create({
    clientId: "codex",
    tool: "moonshine.future.destructive",
    policyId: "pol_abcdefgh",
    requestHash: "a".repeat(64),
    summary: { operation: "future_action", item_count: 2, path: "C:/private" },
  });
  assert.equal(pending.state, "pending");
  assert.equal(JSON.stringify(pending).includes("C:/private"), false);
  assert.equal(approvals.disconnect("codex")[0].disconnected, true);
  assert.equal(approvals.recover("codex")[0].disconnected, false);
  assert.equal(approvals.resolve({ approvalId: pending.approval_id, approved: true }).state, "approved");
  assert.equal(approvals.consume({
    approvalId: pending.approval_id,
    clientId: "codex",
    tool: "moonshine.future.destructive",
    policyId: "pol_abcdefgh",
    requestHash: "a".repeat(64),
  }).accepted, true);
  now += 30_000;
  assert.deepEqual(approvals.sweep(), { expired: 0, pending: 0 });
});

test("Electron main injects the dispatcher and trusted path resolver without auto-starting MCP", async () => {
  const source = await readFile(path.join(root, "src-electron", "electron-main.js"), "utf8");
  assert.match(source, /createMcpApplicationDispatcher\(\{ request: requestMcpBackend \}\)/);
  assert.match(source, /createMcpBridge\(\{[\s\S]*dispatch:[\s\S]*mcpApplicationDispatcher\.dispatch[\s\S]*resolvePath: resolveMcpTrustedPath/);
  assert.match(source, /if \(!Number\.isInteger\(port\)[\s\S]*return \{ ok: false, status: 503/);
  assert.match(source, /function normalizeMcpSamPoints\(points\)/);
  assert.match(source, /points: promptPoints/);
  assert.match(source, /const effectiveBoxes = boxes\.length \? boxes : \(promptPoints\.length \? \[null\] : \[\]\)/);
  assert.match(source, /const usesLegacyInpaintApi = modelId === "lama" \|\| modelId === "mat"/);
  assert.match(source, /path: "\/api\/v1\/model"/);
  assert.match(source, /const requestPath = usesLegacyInpaintApi \? "\/api\/v1\/batch_inpaint"/);
  assert.match(source, /"\/api\/v1\/moonshine\/image\/process"/);
  assert.doesNotMatch(source, /mcpBridge\.start\(/);
});
