import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import net from "node:net";
import os from "node:os";

import { MCP_TOOL_NAMES } from "./mcp-bridge.js";

export const MCP_EXTERNAL_PIPE_PROTOCOL_VERSION = "moonshine-mcp-external-pipe-v1";
export const MCP_EXTERNAL_PROXY_PROTOCOL_VERSION = "2025-11-25";
export const MCP_EXTERNAL_STATUS_TOOL = "moonshine.status";
export const MCP_EXTERNAL_MAX_FRAME_BYTES = 64 * 1024;

const SAFE_CLIENT_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_PIPE_SEGMENT = /^[A-Za-z0-9._-]{8,96}$/;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,96}$/;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_CLIENT_NAME_LENGTH = 128;
const MAX_CLIENT_VERSION_LENGTH = 64;

function asNonEmptyString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function normalizeClientInfoValue(value, maxLength) {
  const source = asNonEmptyString(value);
  const text = source
    ? Array.from(source).filter((character) => {
      const code = character.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    }).join("").trim().slice(0, maxLength)
    : null;
  return text || null;
}

export function normalizeMcpClientInfo(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const name = normalizeClientInfoValue(value.name, MAX_CLIENT_NAME_LENGTH);
  const version = normalizeClientInfoValue(value.version, MAX_CLIENT_VERSION_LENGTH);
  if (!name && !version) return null;
  return Object.freeze({ ...(name ? { name } : {}), ...(version ? { version } : {}) });
}

function externalError(code, data = undefined) {
  const error = new Error(code);
  error.code = code;
  if (data !== undefined) error.data = data;
  return error;
}

function safeErrorCode(value, fallback = "MCP_EXTERNAL_UNAVAILABLE") {
  const code = asNonEmptyString(value);
  return code && SAFE_ERROR_CODE.test(code) ? code : fallback;
}

function writeJsonRpc(socket, id, payload) {
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...payload })}\n`);
}

function normalizedTools() {
  return Object.freeze([...new Set([MCP_EXTERNAL_STATUS_TOOL, ...MCP_TOOL_NAMES])]);
}

export const MCP_EXTERNAL_TOOL_NAMES = normalizedTools();
export const MCP_EXTERNAL_BROKER_BOOTSTRAP_PROTOCOL = "moonshine-mcp-broker-bootstrap-v1";

export function getMcpExternalPipeName({ appId = "moonshine-image", userName = os.userInfo().username } = {}) {
  const app = asNonEmptyString(appId);
  const user = asNonEmptyString(userName);
  if (!app || !user) throw externalError("MCP_PIPE_NAME_INVALID");
  const identity = createHash("sha256").update(`${app}\0${user}`).digest("hex").slice(0, 32);
  return `\\\\.\\pipe\\moonshine-mcp-${identity}`;
}

export function getMcpExternalPrivatePipeName({ nonce = randomBytes(16).toString("hex") } = {}) {
  const normalizedNonce = asNonEmptyString(nonce);
  if (!normalizedNonce || !/^[a-f0-9]{16,128}$/i.test(normalizedNonce)) {
    throw externalError("MCP_PIPE_NAME_INVALID");
  }
  return `\\\\.\\pipe\\moonshine-mcp-internal-${normalizedNonce.toLowerCase()}`;
}

export function isMcpExternalPipeName(value) {
  const pipeName = asNonEmptyString(value);
  const prefix = "\\\\.\\pipe\\moonshine-mcp-";
  if (!pipeName || !pipeName.startsWith(prefix)) return false;
  return SAFE_PIPE_SEGMENT.test(pipeName.slice(prefix.length));
}

function isMcpPrivatePipeName(value) {
  const pipeName = asNonEmptyString(value);
  const prefix = "\\\\.\\pipe\\moonshine-mcp-internal-";
  return Boolean(pipeName && pipeName.startsWith(prefix) && SAFE_PIPE_SEGMENT.test(pipeName.slice(prefix.length)));
}

function equalSecret(expected, supplied) {
  if (typeof expected !== "string" || typeof supplied !== "string" || !expected || expected.length !== supplied.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

export function createMcpExternalBrokerBootstrap({
  publicPipeName,
  privatePipeName,
  brokerSecret,
  expectedProxyExecutablePath,
  expectedProxyExecutableSha256,
  expectedProxyPath,
  expectedProxySha256,
} = {}) {
  const publicPipe = asNonEmptyString(publicPipeName);
  const privatePipe = asNonEmptyString(privatePipeName);
  const secret = asNonEmptyString(brokerSecret);
  const proxyExecutablePath = asNonEmptyString(expectedProxyExecutablePath);
  const proxyExecutableSha256 = asNonEmptyString(expectedProxyExecutableSha256)?.toLowerCase();
  const proxyPath = asNonEmptyString(expectedProxyPath);
  const proxySha256 = asNonEmptyString(expectedProxySha256)?.toLowerCase();
  if (
    !isMcpExternalPipeName(publicPipe)
    || !isMcpPrivatePipeName(privatePipe)
    || !secret
    || secret.length > 512
    || !proxyExecutablePath
    || !/^[a-f0-9]{64}$/.test(proxyExecutableSha256 || "")
    || !proxyPath
    || !/^[a-f0-9]{64}$/.test(proxySha256 || "")
  ) {
    throw externalError("MCP_BROKER_BOOTSTRAP_INVALID");
  }
  return Object.freeze({
    protocol_version: MCP_EXTERNAL_PIPE_PROTOCOL_VERSION,
    public_pipe_name: publicPipe,
    private_pipe_name: privatePipe,
    broker_secret: secret,
    expected_proxy_executable_path: proxyExecutablePath,
    expected_proxy_executable_sha256: proxyExecutableSha256,
    expected_proxy_path: proxyPath,
    expected_proxy_sha256: proxySha256,
  });
}

export function createMcpExternalBrokerBootstrapLine(bootstrap) {
  const value = createMcpExternalBrokerBootstrap(bootstrap);
  const fields = [
    value.public_pipe_name,
    value.private_pipe_name,
    value.broker_secret,
    value.expected_proxy_executable_path,
    value.expected_proxy_executable_sha256,
    value.expected_proxy_path,
    value.expected_proxy_sha256,
  ];
  const payload = fields.map((field) => Buffer.from(field, "utf8").toString("base64url")).join("\t");
  return `${MCP_EXTERNAL_BROKER_BOOTSTRAP_PROTOCOL}\t${payload}\n`;
}

export function createMcpExternalClientConfiguration({ proxyPath, executablePath, appName = "Moonshine Image" } = {}) {
  const normalizedProxyPath = asNonEmptyString(proxyPath);
  const command = asNonEmptyString(executablePath);
  if (!normalizedProxyPath || !command) {
    throw externalError("MCP_CLIENT_CONFIGURATION_INVALID");
  }
  const args = [normalizedProxyPath];
  const env = { ELECTRON_RUN_AS_NODE: "1" };
  const server = { command, args, env };
  return Object.freeze({
    protocolVersion: MCP_EXTERNAL_PROXY_PROTOCOL_VERSION,
    command,
    args: Object.freeze(args),
    env: Object.freeze(env),
    proxyPath: normalizedProxyPath,
    jsonTemplate: Object.freeze({ mcpServers: { [appName]: server } }),
  });
}

function normalizeIdentity(value) {
  if (!value || typeof value !== "object") return null;
  const clientId = asNonEmptyString(value.client_id);
  const proxyPath = asNonEmptyString(value.proxy_path);
  const proxyPid = Number(value.proxy_pid);
  if (!clientId || !SAFE_CLIENT_ID.test(clientId) || !proxyPath || !Number.isSafeInteger(proxyPid) || proxyPid < 1) {
    return null;
  }
  return Object.freeze({ client_id: clientId, proxy_path: proxyPath, proxy_pid: proxyPid });
}

function safeServiceState(value) {
  const source = value && typeof value === "object" ? value : {};
  const enabled = source.enabled === true;
  const running = source.running === true;
  const status = asNonEmptyString(source.status) || (running ? "running" : enabled ? "starting" : "stopped");
  const errorCode = asNonEmptyString(source.error_code);
  return { enabled, running, status, ...(errorCode ? { error_code: safeErrorCode(errorCode, "MCP_SERVICE_UNAVAILABLE") } : {}) };
}

export class McpNamedPipeServer {
  constructor({
    pipeName = getMcpExternalPipeName(),
    dispatch = null,
    getServiceState = () => ({ enabled: false, running: false, status: "stopped" }),
    verifyClientIdentity = null,
    onClientConnected = null,
    onClientDisconnected = null,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    random = randomBytes,
    brokerSecret = null,
  } = {}) {
    if (!isMcpExternalPipeName(pipeName) && !isMcpPrivatePipeName(pipeName)) throw externalError("MCP_PIPE_NAME_INVALID");
    if (dispatch !== null && typeof dispatch !== "function") throw new TypeError("MCP external pipe dispatch must be a function.");
    if (typeof getServiceState !== "function" || typeof random !== "function") {
      throw new TypeError("MCP external pipe requires state and randomness functions.");
    }
    if (onClientConnected !== null && typeof onClientConnected !== "function") {
      throw new TypeError("MCP external pipe onClientConnected must be a function.");
    }
    if (onClientDisconnected !== null && typeof onClientDisconnected !== "function") {
      throw new TypeError("MCP external pipe onClientDisconnected must be a function.");
    }
    this.pipeName = pipeName;
    this.dispatch = dispatch;
    this.getServiceState = getServiceState;
    this.verifyClientIdentity = verifyClientIdentity;
    this.onClientConnected = onClientConnected;
    this.onClientDisconnected = onClientDisconnected;
    this.requestTimeoutMs = requestTimeoutMs;
    this.random = random;
    this.brokerSecret = asNonEmptyString(brokerSecret);
    this.server = null;
    this.sockets = new Set();
    this.sessions = new Map();
  }

  get isListening() {
    return this.server?.listening === true;
  }

  async start() {
    if (this.isListening) return this.getState();
    this.server = net.createServer({ allowHalfOpen: false }, (socket) => this.#serve(socket));
    try {
      await new Promise((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen({ path: this.pipeName, readableAll: false, writableAll: false }, () => {
          this.server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      this.server = null;
      throw externalError(error?.code === "EADDRINUSE" ? "MCP_PIPE_ALREADY_IN_USE" : "MCP_PIPE_START_FAILED");
    }
    return this.getState();
  }

  async sync() {
    return this.start();
  }

  getState() {
    return {
      listening: this.isListening,
      pipe_name: this.pipeName,
      protocol_version: MCP_EXTERNAL_PIPE_PROTOCOL_VERSION,
      sessions: this.sessions.size,
      service: safeServiceState(this.getServiceState()),
      peer_pid_verification: "required",
    };
  }

  getSessions() {
    return [...this.sessions.values()].map(({ session_id, client_id, client_info, connected_at }) => ({
      session_id,
      client_id,
      client_name: client_info?.name || null,
      client_version: client_info?.version || null,
      connected_at,
    }));
  }

  async disconnect(sessionId) {
    const session = this.sessions.get(asNonEmptyString(sessionId));
    if (!session) return false;
    this.#removeSession(session);
    session.socket.destroy();
    return true;
  }

  probe() {
    return {
      ...this.getState(),
      transport: "windows-named-pipe",
      // Node net exposes neither Windows SDDL nor a peer-PID primitive. A host
      // native verifier is therefore required before clients are accepted.
      pipe_acl: "host-native-verifier-required",
      identity_verification: this.verifyClientIdentity ? "configured" : "not-configured",
    };
  }

  getClientConfiguration(options) {
    return createMcpExternalClientConfiguration(options);
  }

  async stop() {
    for (const session of this.sessions.values()) this.#removeSession(session);
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.sessions.clear();
    const server = this.server;
    this.server = null;
    if (!server) return this.getState();
    await new Promise((resolve) => server.close(() => resolve()));
    return this.getState();
  }

  #newSessionId() {
    return `mps_${this.random(16).toString("hex")}`;
  }

  #removeSession(session) {
    if (!session || session.disconnectedNotified) return;
    session.disconnectedNotified = true;
    if (this.sessions.get(session.session_id) === session) {
      this.sessions.delete(session.session_id);
    }
    try {
      this.onClientDisconnected?.(session.client_id, session.session_id);
    } catch {
      // Session cleanup must not keep a pipe close handler alive.
    }
  }

  #serve(socket) {
    let pending = "";
    let session = null;
    // The private pipe is only exposed to the native broker. The broker proves
    // it received the one-time secret before a proxy handshake may establish a
    // renderer-visible client session.
    let brokerAttested = false;
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.once("close", () => {
      this.sockets.delete(socket);
      this.#removeSession(session);
    });
    socket.on("data", (chunk) => {
      pending += chunk;
      while (true) {
        const boundary = pending.indexOf("\n");
        if (boundary < 0) break;
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        if (Buffer.byteLength(line, "utf8") > MCP_EXTERNAL_MAX_FRAME_BYTES) {
          writeJsonRpc(socket, null, { error: { code: "REQUEST_TOO_LARGE", message: "REQUEST_TOO_LARGE" } });
          socket.destroy();
          return;
        }
        if (!line) continue;
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          writeJsonRpc(socket, null, { error: { code: "PARSE_ERROR", message: "PARSE_ERROR" } });
          continue;
        }
        if (request?.jsonrpc !== "2.0" || !Object.hasOwn(request, "id")) {
          writeJsonRpc(socket, request?.id ?? null, { error: { code: "INVALID_REQUEST", message: "INVALID_REQUEST" } });
          continue;
        }
        this.#handleRequest(request, socket, session, brokerAttested)
          .then((outcome) => {
            if (outcome.session) session = outcome.session;
            if (outcome.brokerAttested === true) brokerAttested = true;
            writeJsonRpc(socket, request.id, outcome.payload);
          })
          .catch((error) => writeJsonRpc(socket, request.id, { error: { code: safeErrorCode(error?.code), message: safeErrorCode(error?.code) } }));
      }
      if (Buffer.byteLength(pending, "utf8") > MCP_EXTERNAL_MAX_FRAME_BYTES) {
        writeJsonRpc(socket, null, { error: { code: "REQUEST_TOO_LARGE", message: "REQUEST_TOO_LARGE" } });
        socket.destroy();
      }
    });
  }

  async #handleRequest(request, socket, currentSession, brokerAttested) {
    const params = request.params && typeof request.params === "object" ? request.params : {};
    if (request.method === "moonshine.external.broker_attest") {
      if (!this.brokerSecret) {
        return { payload: { error: { code: "MCP_BROKER_ATTESTATION_UNEXPECTED", message: "MCP_BROKER_ATTESTATION_UNEXPECTED" } } };
      }
      if (params.protocol_version !== MCP_EXTERNAL_PIPE_PROTOCOL_VERSION || !equalSecret(this.brokerSecret, params.broker_secret)) {
        return { payload: { error: { code: "MCP_BROKER_ATTESTATION_DENIED", message: "MCP_BROKER_ATTESTATION_DENIED" } } };
      }
      return {
        brokerAttested: true,
        payload: { result: { broker_attested: true, protocol_version: MCP_EXTERNAL_PIPE_PROTOCOL_VERSION } },
      };
    }
    if (request.method === "moonshine.external.handshake") {
      if (params.protocol_version !== MCP_EXTERNAL_PIPE_PROTOCOL_VERSION) {
        return { payload: { error: { code: "MCP_PIPE_PROTOCOL_MISMATCH", message: "MCP_PIPE_PROTOCOL_MISMATCH" } } };
      }
      const identity = normalizeIdentity(params.identity);
      if (!identity) return { payload: { error: { code: "MCP_PROXY_IDENTITY_INVALID", message: "MCP_PROXY_IDENTITY_INVALID" } } };
      if (this.brokerSecret && !brokerAttested) {
        return { payload: { error: { code: "MCP_BROKER_ATTESTATION_REQUIRED", message: "MCP_BROKER_ATTESTATION_REQUIRED" } } };
      }
      if (!this.brokerSecret && typeof this.verifyClientIdentity !== "function") {
        return { payload: { error: { code: "MCP_PROXY_IDENTITY_UNVERIFIED", message: "MCP_PROXY_IDENTITY_UNVERIFIED" } } };
      }
      if (typeof this.verifyClientIdentity !== "function") {
        // The private pipe is reachable only by the native broker, which has
        // already verified the real Windows client process identity.
      } else {
        let accepted = false;
        try {
          accepted = (await this.verifyClientIdentity({ identity, socket, pipe_name: this.pipeName })) === true;
        } catch {
          accepted = false;
        }
        if (!accepted) return { payload: { error: { code: "MCP_PROXY_IDENTITY_DENIED", message: "MCP_PROXY_IDENTITY_DENIED" } } };
      }
      if (currentSession) this.#removeSession(currentSession);
      const session = {
        session_id: this.#newSessionId(),
        client_id: identity.client_id,
        client_info: null,
        connected_at: new Date().toISOString(),
        socket,
        disconnectedNotified: false,
      };
      this.sessions.set(session.session_id, session);
      try {
        this.onClientConnected?.(session.client_id, session.session_id);
      } catch {
        // Connection observers are advisory; protocol state remains authoritative.
      }
      return {
        session,
        payload: { result: { protocol_version: MCP_EXTERNAL_PIPE_PROTOCOL_VERSION, session_id: session.session_id } },
      };
    }
    if (request.method !== "moonshine.external.call") {
      return { payload: { error: { code: "METHOD_NOT_FOUND", message: "METHOD_NOT_FOUND" } } };
    }
    if (!currentSession || params.session_id !== currentSession.session_id || !this.sessions.has(currentSession.session_id)) {
      return { payload: { error: { code: "MCP_PIPE_SESSION_REQUIRED", message: "MCP_PIPE_SESSION_REQUIRED" } } };
    }
    const clientInfo = normalizeMcpClientInfo(params.client_info);
    if (clientInfo) currentSession.client_info = clientInfo;
    const tool = asNonEmptyString(params.tool);
    if (!tool || !MCP_EXTERNAL_TOOL_NAMES.includes(tool)) {
      return { payload: { error: { code: "TOOL_NOT_ALLOWED", message: "TOOL_NOT_ALLOWED" } } };
    }
    if (tool === MCP_EXTERNAL_STATUS_TOOL) return { payload: { result: { ...safeServiceState(this.getServiceState()), listening: true } } };
    const service = safeServiceState(this.getServiceState());
    if (!service.enabled) return { payload: { error: { code: "MCP_SERVICE_DISABLED", message: "MCP_SERVICE_DISABLED" } } };
    if (!service.running || !this.dispatch) return { payload: { error: { code: "APP_NOT_RUNNING", message: "APP_NOT_RUNNING" } } };
    try {
      const result = await Promise.race([
        this.dispatch({ tool, params: params.arguments && typeof params.arguments === "object" ? params.arguments : {}, clientId: currentSession.client_id, clientInfo: currentSession.client_info }),
        new Promise((_, reject) => setTimeout(() => reject(externalError("MCP_EXTERNAL_DISPATCH_TIMEOUT")), this.requestTimeoutMs)),
      ]);
      return { payload: { result: result && typeof result === "object" ? result : {} } };
    } catch (error) {
      const code = safeErrorCode(error?.code, "MCP_EXTERNAL_DISPATCH_FAILED");
      return { payload: { error: { code, message: code } } };
    }
  }
}

export function createMcpNamedPipeServer(options) {
  return new McpNamedPipeServer(options);
}

export class McpExternalPipeClient {
  constructor({ pipeName, identity, brokerSecret = null, socketFactory = net.createConnection, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    if (!isMcpExternalPipeName(pipeName) && !isMcpPrivatePipeName(pipeName)) throw externalError("MCP_PIPE_NAME_INVALID");
    this.pipeName = pipeName;
    this.identity = normalizeIdentity(identity);
    if (!this.identity) throw externalError("MCP_PROXY_IDENTITY_INVALID");
    this.socketFactory = socketFactory;
    this.brokerSecret = asNonEmptyString(brokerSecret);
    this.requestTimeoutMs = requestTimeoutMs;
    this.socket = null;
    this.buffer = "";
    this.pending = new Map();
    this.sessionId = null;
    this.clientInfo = null;
    this.nextId = 1;
    this.connectPromise = null;
  }

  async status() {
    return this.call(MCP_EXTERNAL_STATUS_TOOL, {});
  }

  async call(tool, args = {}, clientInfo = undefined) {
    await this.connect();
    if (clientInfo !== undefined) this.clientInfo = normalizeMcpClientInfo(clientInfo);
    const response = await this.#request("moonshine.external.call", {
      session_id: this.sessionId,
      tool,
      arguments: args,
      ...(this.clientInfo ? { client_info: this.clientInfo } : {}),
    });
    if (response.error) throw externalError(safeErrorCode(response.error.code));
    return response.result || {};
  }

  async connect() {
    if (this.sessionId && this.socket && !this.socket.destroyed) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.#connect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async close() {
    this.sessionId = null;
    this.buffer = "";
    const socket = this.socket;
    this.socket = null;
    this.#rejectPending(externalError("MCP_PIPE_CLOSED"));
    if (socket && !socket.destroyed) {
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, this.requestTimeoutMs);
        socket.once("close", finish);
        socket.destroy();
      });
    }
  }

  async #connect() {
    await this.close();
    const socket = this.socketFactory({ path: this.pipeName });
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.#handleData(chunk));
    socket.on("error", () => this.#rejectPending(externalError("APP_NOT_RUNNING")));
    socket.on("close", () => {
      this.sessionId = null;
      this.#rejectPending(externalError("APP_NOT_RUNNING"));
    });
    await new Promise((resolve, reject) => {
      const onConnect = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(externalError("APP_NOT_RUNNING")); };
      const cleanup = () => { socket.off("connect", onConnect); socket.off("error", onError); };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
    const response = await this.#request("moonshine.external.handshake", {
      protocol_version: MCP_EXTERNAL_PIPE_PROTOCOL_VERSION,
      identity: this.identity,
      ...(this.brokerSecret ? { broker_secret: this.brokerSecret } : {}),
    });
    if (response.error || !asNonEmptyString(response.result?.session_id)) {
      throw externalError(safeErrorCode(response.error?.code, "MCP_PIPE_HANDSHAKE_FAILED"));
    }
    this.sessionId = response.result.session_id;
  }

  #handleData(chunk) {
    this.buffer += chunk;
    while (true) {
      const boundary = this.buffer.indexOf("\n");
      if (boundary < 0) break;
      const line = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 1);
      let response;
      try { response = JSON.parse(line); } catch { continue; }
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      pending.resolve(response);
    }
  }

  #request(method, params) {
    if (!this.socket || this.socket.destroyed) return Promise.reject(externalError("APP_NOT_RUNNING"));
    const id = `pipe_${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(externalError("MCP_PIPE_TIMEOUT"));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(externalError("APP_NOT_RUNNING"));
      }
    });
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
