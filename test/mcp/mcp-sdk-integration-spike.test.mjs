import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SDK_SPEC = "@modelcontextprotocol/sdk@1.30.0";
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";
const SDK_METADATA = {
  version: "1.30.0",
  license: "MIT",
  node: ">=18",
  resolved: "https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.30.0.tgz",
  integrity: "sha512-xKd8OIzlqNzcqcNumGAa6g+PW2kjD5vrpcKOnfldAUPP3j7lnqMPwlTXQm8gF+UwH72z0lqaRbjr9hqGz0eITA==",
};

function installSdk(temporaryRoot) {
  const args = [
    "install",
    "--prefix",
    temporaryRoot,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=true",
    SDK_SPEC,
  ];
  if (process.platform === "win32") {
    const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    assert.ok(existsSync(npmCli), `npm CLI is unavailable beside ${process.execPath}`);
    execFileSync(process.execPath, [npmCli, ...args], { stdio: "pipe" });
    return;
  }
  execFileSync(NPM_COMMAND, args, { stdio: "pipe" });
}

async function assertInstalledSdk(temporaryRoot) {
  const packageJson = JSON.parse(
    await readFile(path.join(temporaryRoot, "node_modules", "@modelcontextprotocol", "sdk", "package.json"), "utf8")
  );
  const packageLock = JSON.parse(await readFile(path.join(temporaryRoot, "package-lock.json"), "utf8"));
  const lockedSdk = packageLock.packages["node_modules/@modelcontextprotocol/sdk"];

  assert.equal(packageJson.version, SDK_METADATA.version);
  assert.equal(packageJson.license, SDK_METADATA.license);
  assert.equal(packageJson.engines.node, SDK_METADATA.node);
  assert.equal(lockedSdk.version, SDK_METADATA.version);
  assert.equal(lockedSdk.resolved, SDK_METADATA.resolved);
  assert.equal(lockedSdk.integrity, SDK_METADATA.integrity);
}

async function removeTemporaryRoot(temporaryRoot) {
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  assert.equal(existsSync(temporaryRoot), false, `Temporary SDK root was not removed: ${temporaryRoot}`);
}

const SERVER_SOURCE = `
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "moonshine-sdk-spike", version: "0.0.0" });
server.tool("ping", async () => ({ content: [{ type: "text", text: "pong" }] }));
await server.connect(new StdioServerTransport());
`;

function waitForResponses(child, expectedIds) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("MCP SDK stdio smoke timed out.")), 15000);

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const settle = () => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      };
      if (child.exitCode !== null || child.signalCode !== null) {
        settle();
        return;
      }
      child.once("close", settle);
      child.kill();
    };

    child.on("error", finish);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const messages = stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        });
      const responseIds = new Set(messages.filter(Boolean).map((message) => message.id));
      if (expectedIds.every((id) => responseIds.has(id))) finish();
    });
  });
}

test("real MCP SDK keeps stdio output JSON-RPC-only without touching the project", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "moonshine mcp sdk-"));
  try {
    assert.match(temporaryRoot, /moonshine mcp sdk-/);
    installSdk(temporaryRoot);
    await assertInstalledSdk(temporaryRoot);
    await writeFile(path.join(temporaryRoot, "child.mjs"), SERVER_SOURCE, "utf8");

    const child = spawn(process.execPath, ["child.mjs"], {
      cwd: temporaryRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const responses = waitForResponses(child, [1, 2, 3]);
    child.stdin.write(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "moonshine-spike", version: "0" },
          },
        }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ping", arguments: {} } }),
      ].join("\n") + "\n"
    );

    const { stdout, stderr } = await responses;
    const messages = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(messages.every((message) => message.jsonrpc === "2.0"));
    assert.ok(messages.some((message) => message.id === 1 && message.result));
    assert.ok(messages.some((message) => message.id === 2 && message.result?.tools?.some((tool) => tool.name === "ping")));
    assert.deepEqual(
      messages.find((message) => message.id === 3)?.result?.content,
      [{ type: "text", text: "pong" }]
    );
    assert.equal(stderr, "");
  } finally {
    await removeTemporaryRoot(temporaryRoot);
  }
});
