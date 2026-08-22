import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createMcpApplicationDispatcher,
  McpApplicationDispatchError,
} from "../../src-electron/mcp-application-dispatcher.js";

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
    { tools: ["moonshine.capabilities"] },
  );
});

test("Electron main injects the dispatcher and trusted path resolver without auto-starting MCP", async () => {
  const source = await readFile(path.join(root, "src-electron", "electron-main.js"), "utf8");
  assert.match(source, /createMcpApplicationDispatcher\(\{ request: requestMcpBackend \}\)/);
  assert.match(source, /createMcpBridge\(\{[\s\S]*dispatch:[\s\S]*mcpApplicationDispatcher\.dispatch[\s\S]*resolvePath: resolveMcpTrustedPath/);
  assert.match(source, /if \(!Number\.isInteger\(port\)[\s\S]*return \{ ok: false, status: 503/);
  assert.doesNotMatch(source, /mcpBridge\.start\(/);
});
