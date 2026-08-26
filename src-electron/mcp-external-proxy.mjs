import { fileURLToPath } from "node:url";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TOOL_DEFINITIONS } from "./mcp-application-dispatcher.js";

import {
  MCP_EXTERNAL_PROXY_PROTOCOL_VERSION,
  MCP_EXTERNAL_STATUS_TOOL,
  MCP_EXTERNAL_TOOL_NAMES,
  McpExternalPipeClient,
  getMcpExternalPipeName,
  isMcpExternalPipeName,
  normalizeMcpClientInfo,
} from "./mcp-external-pipe.js";

const MAX_FRAME_BYTES = 64 * 1024;

function proxyError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function argumentValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) return null;
  const value = String(argv[index + 1] || "").trim();
  return value || null;
}

function resultText(value) {
  try { return JSON.stringify(value || {}); } catch { return "{}"; }
}

function unavailableResult(code) {
  return {
    isError: true,
    content: [{ type: "text", text: code }],
    structuredContent: { error: { code } },
  };
}

function zodSchemaFromJson(schema = {}) {
  if (!schema || typeof schema !== "object") return z.any();
  if (schema.enum) return z.enum(schema.enum);
  if (schema.type === "string") {
    let value = z.string();
    if (schema.minLength !== undefined) value = value.min(schema.minLength);
    if (schema.maxLength !== undefined) value = value.max(schema.maxLength);
    if (schema.pattern) value = value.regex(new RegExp(schema.pattern));
    return value;
  }
  if (schema.type === "array") {
    let value = z.array(zodSchemaFromJson(schema.items));
    if (schema.minItems !== undefined) value = value.min(schema.minItems);
    if (schema.maxItems !== undefined) value = value.max(schema.maxItems);
    return value;
  }
  if (schema.type === "object") {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    const shape = Object.fromEntries(Object.entries(properties).map(([key, value]) => [
      key,
      required.has(key) ? zodSchemaFromJson(value) : zodSchemaFromJson(value).optional(),
    ]));
    return schema.additionalProperties === false ? z.object(shape).strict() : z.object(shape).passthrough();
  }
  return z.any();
}

function toolInputSchema(tool) {
  const definition = TOOL_DEFINITIONS.find((item) => item.name === tool);
  return zodSchemaFromJson(definition?.inputSchema || { type: "object" });
}

export function parseMcpExternalProxyArguments(argv = process.argv.slice(2)) {
  const pipeName = argumentValue(argv, "--pipe");
  if (pipeName !== null && !isMcpExternalPipeName(pipeName)) throw proxyError("MCP_PROXY_PIPE_INVALID");
  return Object.freeze({ pipeName: pipeName || getMcpExternalPipeName() });
}

export function createMcpExternalProxyIdentity({ proxyPath = fileURLToPath(import.meta.url), clientId = `stdio-${process.pid}` } = {}) {
  return Object.freeze({ client_id: clientId, proxy_path: proxyPath, proxy_pid: process.pid });
}

export function createMcpExternalProxyServer({ pipeName, identity = createMcpExternalProxyIdentity(), pipeClient } = {}) {
  const client = pipeClient || new McpExternalPipeClient({ pipeName, identity });
  const server = new McpServer({ name: "moonshine-image", version: "2.0.0-external" });
  for (const tool of MCP_EXTERNAL_TOOL_NAMES) {
    server.registerTool(tool, { description: `Moonshine ${tool}`, inputSchema: toolInputSchema(tool) }, async (args) => {
      try {
        const clientInfo = normalizeMcpClientInfo(server.server?.getClientVersion?.());
        const result = await client.call(tool, args || {}, clientInfo);
        return { content: [{ type: "text", text: resultText(result) }], structuredContent: result };
      } catch (error) {
        const code = error?.code || (tool === MCP_EXTERNAL_STATUS_TOOL ? "APP_NOT_RUNNING" : "MCP_SERVICE_UNAVAILABLE");
        return unavailableResult(code);
      }
    });
  }
  return { server, client };
}

export async function startMcpExternalProxy({ input = process.stdin, output = process.stdout, ...options } = {}) {
  const { server, client } = createMcpExternalProxyServer(options);
  const transport = new StdioServerTransport(input, output, { maxBufferSize: MAX_FRAME_BYTES });
  await server.connect(transport);
  return { server, client, transport, protocolVersion: MCP_EXTERNAL_PROXY_PROTOCOL_VERSION };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await startMcpExternalProxy(parseMcpExternalProxyArguments());
  } catch (error) {
    process.stderr.write(`${error?.code || "MCP_PROXY_START_FAILED"}\n`);
    process.exitCode = 1;
  }
}
