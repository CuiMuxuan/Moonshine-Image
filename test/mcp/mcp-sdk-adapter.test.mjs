import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MCP_TOOL_NAMES, McpBridge } from "../../src-electron/mcp-bridge.js";

const SERVER_PATH = path.resolve("src-electron/mcp-stdio-server.mjs");
const TOKEN = "adapter-test-token";
const PROFILE = "desktop-default";

function sendRequests(child, requests, expectedIds) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`MCP adapter response timeout. stdout=${stdout} stderr=${stderr}`)), 15000);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      const complete = () => (error ? reject(error) : resolve({ stdout, stderr }));
      if (child.exitCode !== null || child.signalCode !== null) complete();
      else {
        child.once("close", complete);
        child.kill();
      }
    };
    child.once("error", finish);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const messages = stdout.split("\n").filter(Boolean).flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      if (expectedIds.every((id) => messages.some((message) => message.id === id))) finish();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.write(requests.map((request) => JSON.stringify(request)).join("\n") + "\n");
  });
}

function spawnAdapter(env) {
  return spawn(process.execPath, [SERVER_PATH], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

test("MCP stdio adapter proxies SDK calls through the bridge without leaking secrets", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "moonshine-mcp-adapter-"));
  let dispatchCount = 0;
  const bridge = new McpBridge({
    dispatch: async ({ tool }) => {
      dispatchCount += 1;
      return { job_id: "job_adapter_1234", status: "accepted", tool };
    },
    resolvePath: async (candidate) => ({
      canonical_path: path.resolve(candidate),
      is_symlink: false,
      is_junction: false,
      is_device: false,
      is_unc: false,
    }),
  });
  try {
    const descriptor = await bridge.start({
      enabled: true,
      profile: PROFILE,
      token: TOKEN,
      allowedRoots: [path.join(tempRoot, "inputs")],
      allowedTools: MCP_TOOL_NAMES,
      confirmationRequired: true,
    });
    const descriptorPath = path.join(tempRoot, "descriptor.json");
    await writeFile(descriptorPath, JSON.stringify(descriptor), "utf8");
    const child = spawnAdapter({
      MOONSHINE_MCP_ENABLED: "1",
      MOONSHINE_MCP_DESCRIPTOR_PATH: descriptorPath,
      MOONSHINE_MCP_TOKEN: TOKEN,
      MOONSHINE_MCP_PROFILE: PROFILE,
      MOONSHINE_MCP_CLIENT_ID: "adapter-test",
    });
    const { stdout, stderr } = await sendRequests(
      child,
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "adapter-test", version: "1" } },
        },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "moonshine.capabilities", arguments: {} } },
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "moonshine.jobs.get", arguments: { job_id: "bad" } } },
      ],
      [1, 2, 3, 4]
    );
    const messages = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(messages.every((message) => message.jsonrpc === "2.0"));
    assert.ok(messages.find((message) => message.id === 2)?.result?.tools?.some((tool) => tool.name === "moonshine.capabilities"));
    const capabilities = messages.find((message) => message.id === 3)?.result?.structuredContent;
    assert.deepEqual(capabilities?.tools, MCP_TOOL_NAMES);
    assert.deepEqual(capabilities?.allowed_tools, MCP_TOOL_NAMES);
    assert.equal(capabilities?.policy?.confirmation_mode, "read_only");
    assert.match(capabilities?.policy?.policy_snapshot_id || "", /^pol_mcp_[a-f0-9]{16}$/);
    assert.equal(messages.find((message) => message.id === 4)?.result?.isError, true);
    assert.match(messages.find((message) => message.id === 4)?.result?.content?.[0]?.text || "", /Input validation error|INVALID_JOB_ID/);
    assert.equal(dispatchCount, 1);
    assert.equal(stderr, "");
    assert.doesNotMatch(stdout, new RegExp(TOKEN));
    assert.doesNotMatch(stdout, new RegExp(tempRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await bridge.stop();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("MCP stdio adapter is disabled by default and exits without output", async () => {
  const child = spawnAdapter({
    MOONSHINE_MCP_ENABLED: "0",
    MOONSHINE_MCP_DESCRIPTOR_PATH: "",
    MOONSHINE_MCP_TOKEN: "",
  });
  const chunks = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (chunks.stdout += chunk));
  child.stderr.on("data", (chunk) => (chunks.stderr += chunk));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  assert.equal(exitCode, 0);
  assert.equal(chunks.stdout, "");
  assert.equal(chunks.stderr, "");
});

test("descriptor reader rejects non-loopback endpoints and oversized content", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "moonshine-mcp-adapter-invalid-"));
  try {
    const descriptorPath = path.join(tempRoot, "descriptor.json");
    await writeFile(descriptorPath, JSON.stringify({ endpoint: { host: "0.0.0.0", port: 1 }, profile: PROFILE, policy_snapshot_id: "pol_test" }), "utf8");
    const child = spawnAdapter({ MOONSHINE_MCP_ENABLED: "1", MOONSHINE_MCP_DESCRIPTOR_PATH: descriptorPath, MOONSHINE_MCP_TOKEN: TOKEN });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    assert.equal(exitCode, 1);
    assert.equal(stderr.trim(), "MCP_DESCRIPTOR_INVALID");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
