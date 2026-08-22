import { readFile } from "node:fs/promises";
import net from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MCP_TOOL_NAMES } from "./mcp-bridge.js";

const MCP_SERVER_NAME = "moonshine-image";
const MCP_SERVER_VERSION = "2.0.0-dev";
const DEFAULT_CLIENT_ID = "stdio-adapter";
const MAX_DESCRIPTOR_BYTES = 16 * 1024;
const MAX_FRAME_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const SAFE_CLIENT_ID = /^[A-Za-z0-9._-]{1,64}$/;

function asNonEmptyString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function adapterError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function parseDescriptor(value) {
  if (!value || typeof value !== "object") throw adapterError("MCP_DESCRIPTOR_INVALID");
  const host = value.endpoint?.host;
  const port = Number(value.endpoint?.port);
  const profile = asNonEmptyString(value.profile);
  const policySnapshotId = asNonEmptyString(value.policy_snapshot_id ?? value.policySnapshotId);
  if (host !== "127.0.0.1" || !Number.isInteger(port) || port < 1 || port > 65535 || !profile || !policySnapshotId) {
    throw adapterError("MCP_DESCRIPTOR_INVALID");
  }
  const sourceTools = value.allowed_tools ?? value.allowedTools;
  const allowedTools = Array.isArray(sourceTools)
    ? sourceTools.filter((tool) => MCP_TOOL_NAMES.includes(tool))
    : MCP_TOOL_NAMES.slice();
  if (!allowedTools.length) throw adapterError("MCP_DESCRIPTOR_INVALID");
  return Object.freeze({
    endpoint: Object.freeze({ host, port }),
    profile,
    policySnapshotId,
    allowedTools: Object.freeze([...new Set(allowedTools)]),
  });
}

async function readDescriptorFile(descriptorPath) {
  const path = asNonEmptyString(descriptorPath);
  if (!path) throw adapterError("MCP_DESCRIPTOR_REQUIRED");
  const content = await readFile(path, "utf8");
  if (Buffer.byteLength(content, "utf8") > MAX_DESCRIPTOR_BYTES) throw adapterError("MCP_DESCRIPTOR_INVALID");
  try {
    return parseDescriptor(JSON.parse(content));
  } catch (error) {
    if (error?.code?.startsWith("MCP_")) throw error;
    throw adapterError("MCP_DESCRIPTOR_INVALID");
  }
}

function validateToken(token) {
  const value = asNonEmptyString(token);
  if (!value || value.length > 512) throw adapterError("MCP_TOKEN_REQUIRED");
  return value;
}

function validateClientId(clientId) {
  const value = asNonEmptyString(clientId) || DEFAULT_CLIENT_ID;
  if (!SAFE_CLIENT_ID.test(value)) throw adapterError("MCP_CLIENT_ID_INVALID");
  return value;
}

function resultText(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

export class McpBridgeClient {
  constructor({ descriptor, token, profile, clientId = DEFAULT_CLIENT_ID, socketFactory = net.createConnection } = {}) {
    this.descriptor = parseDescriptor(descriptor);
    this.token = validateToken(token);
    this.profile = asNonEmptyString(profile) || this.descriptor.profile;
    this.clientId = validateClientId(clientId);
    this.socketFactory = socketFactory;
    this.socket = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.buffer = "";
    this.connected = false;
    this.connectPromise = null;
  }

  async connect() {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.#connect();
    try {
      await this.connectPromise;
    } catch (error) {
      this.socket?.destroy();
      this.socket = null;
      this.connected = false;
      throw error;
    } finally {
      this.connectPromise = null;
    }
  }

  async #connect() {
    this.socket = this.socketFactory({ host: this.descriptor.endpoint.host, port: this.descriptor.endpoint.port });
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => this.#handleData(chunk));
    this.socket.on("error", (error) => this.#failPending(error));
    this.socket.on("close", () => this.#failPending(adapterError("MCP_BRIDGE_UNAVAILABLE")));
    await new Promise((resolve, reject) => {
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(adapterError(error?.code === "ECONNREFUSED" ? "MCP_BRIDGE_UNAVAILABLE" : "MCP_BRIDGE_CONNECT_FAILED"));
      };
      const cleanup = () => {
        this.socket.off("connect", onConnect);
        this.socket.off("error", onError);
      };
      this.socket.once("connect", onConnect);
      this.socket.once("error", onError);
    });
    const response = await this.#request("bridge.handshake", {
      protocol_version: "moonshine-mcp-v1",
      profile: this.profile,
      token: this.token,
      client_id: this.clientId,
    });
    if (response.error) throw adapterError(response.error.code || "MCP_AUTH_FAILED");
    if (response.result?.policy_snapshot_id !== this.descriptor.policySnapshotId) throw adapterError("MCP_POLICY_CHANGED");
    this.connected = true;
  }

  async call(tool, params = {}) {
    await this.connect();
    const safeParams = params && typeof params === "object" ? { ...params } : {};
    delete safeParams.tool;
    const response = await this.#request("bridge.call", { ...safeParams, tool });
    return response.error ? { error: { code: String(response.error.code || "MCP_CALL_FAILED") } } : { result: response.result || {} };
  }

  async close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(adapterError("MCP_BRIDGE_CLOSED"));
    }
    this.pending.clear();
    this.connected = false;
    this.socket?.destroy();
    this.socket = null;
  }

  #handleData(chunk) {
    this.buffer += chunk;
    let boundary = this.buffer.indexOf("\n");
    while (boundary !== -1) {
      const line = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 1);
      boundary = this.buffer.indexOf("\n");
      if (!line) continue;
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        continue;
      }
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      pending.resolve(response);
    }
  }

  #request(method, params) {
    if (!this.socket || this.socket.destroyed) return Promise.reject(adapterError("MCP_BRIDGE_UNAVAILABLE"));
    const id = `adapter_${this.nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(adapterError("MCP_BRIDGE_TIMEOUT"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(adapterError("MCP_BRIDGE_UNAVAILABLE"));
      }
    });
  }

  #failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function createMcpSdkServer({ bridgeClient, allowedTools = MCP_TOOL_NAMES } = {}) {
  if (!bridgeClient || typeof bridgeClient.call !== "function") throw new TypeError("Mcp SDK adapter requires a bridge client.");
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
  for (const tool of [...new Set(allowedTools)].filter((candidate) => MCP_TOOL_NAMES.includes(candidate))) {
    server.registerTool(tool, { description: `Moonshine ${tool}` }, async (args) => {
      try {
        const response = await bridgeClient.call(tool, args || {});
        if (response.error) {
          return {
            isError: true,
            content: [{ type: "text", text: response.error.code }],
            structuredContent: { error: { code: response.error.code } },
          };
        }
        return {
          content: [{ type: "text", text: resultText(response.result) }],
          structuredContent: response.result || {},
        };
      } catch (error) {
        const code = error?.code?.startsWith("MCP_") ? error.code : "MCP_CALL_FAILED";
        return { isError: true, content: [{ type: "text", text: code }], structuredContent: { error: { code } } };
      }
    });
  }
  return server;
}

export async function startMcpStdioAdapter({
  descriptor,
  token,
  profile,
  clientId = DEFAULT_CLIENT_ID,
  input = process.stdin,
  output = process.stdout,
  socketFactory,
} = {}) {
  const bridgeClient = new McpBridgeClient({ descriptor, token, profile, clientId, socketFactory });
  await bridgeClient.connect();
  const server = createMcpSdkServer({ bridgeClient, allowedTools: bridgeClient.descriptor.allowedTools });
  const transport = new StdioServerTransport(input, output, { maxBufferSize: MAX_FRAME_BYTES });
  await server.connect(transport);
  return { server, transport, bridgeClient };
}

export async function loadMcpDescriptorFromEnvironment(env = process.env) {
  return readDescriptorFile(env.MOONSHINE_MCP_DESCRIPTOR_PATH);
}

export function isMcpStdioEnabled(env = process.env) {
  return env.MOONSHINE_MCP_ENABLED === "1";
}

export async function runMcpStdioAdapter(env = process.env) {
  if (!isMcpStdioEnabled(env)) return { enabled: false };
  const descriptor = await loadMcpDescriptorFromEnvironment(env);
  const adapter = await startMcpStdioAdapter({
    descriptor,
    token: env.MOONSHINE_MCP_TOKEN,
    profile: env.MOONSHINE_MCP_PROFILE,
    clientId: env.MOONSHINE_MCP_CLIENT_ID,
  });
  const close = () => void adapter.server.close().catch(() => null).finally(() => adapter.bridgeClient.close());
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return { enabled: true, ...adapter };
}
