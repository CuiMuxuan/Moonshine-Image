import { randomBytes } from "node:crypto";
import { spawn as spawnChild } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { MCP_TOOL_NAMES } from "./mcp-bridge.js";

const READY_MESSAGE = "moonshine-mcp-ready";
const FAILED_MESSAGE = "moonshine-mcp-failed";
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const SAFE_ERROR_CODE = /^MCP_[A-Z0-9_]{1,64}$/;

function asNonEmptyString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function safeErrorCode(value, fallback = "MCP_START_FAILED") {
  const code = asNonEmptyString(value);
  return code && SAFE_ERROR_CODE.test(code) ? code : fallback;
}

function lifecycleError(code) {
  const error = new Error(code);
  error.code = safeErrorCode(code);
  return error;
}

function normalizePolicy(config = {}) {
  const profile = asNonEmptyString(config.profileId);
  const allowedRoots = Array.isArray(config.allowedRoots)
    ? [...new Set(config.allowedRoots.map(asNonEmptyString).filter(Boolean))]
    : [];
  const allowedTools = Array.isArray(config.allowedTools)
    ? MCP_TOOL_NAMES.filter((tool) => config.allowedTools.includes(tool))
    : [];
  return Object.freeze({
    enabled: config.enabled === true,
    profile,
    allowedRoots: Object.freeze(allowedRoots),
    allowedTools: Object.freeze(allowedTools),
    confirmationRequired: config.confirmationRequired !== false,
  });
}

function policyIdentity(policy) {
  return JSON.stringify({
    enabled: policy.enabled,
    profile: policy.profile,
    allowedRoots: policy.allowedRoots,
    allowedTools: policy.allowedTools,
    confirmationRequired: policy.confirmationRequired,
  });
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off?.("exit", onExit);
      child.off?.("error", onError);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const onError = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once?.("exit", onExit);
    child.once?.("error", onError);
  });
}

export class McpProcessManager {
  constructor({
    bridge,
    adapterScript,
    tempRoot,
    execPath = process.execPath,
    spawn = spawnChild,
    baseEnv = process.env,
    random = randomBytes,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  } = {}) {
    if (!bridge || typeof bridge.start !== "function" || typeof bridge.stop !== "function") {
      throw new TypeError("MCP process manager requires a bridge.");
    }
    if (!asNonEmptyString(adapterScript) || !asNonEmptyString(tempRoot)) {
      throw new TypeError("MCP process manager requires adapter and temporary paths.");
    }
    if (typeof spawn !== "function" || typeof random !== "function") {
      throw new TypeError("MCP process manager requires spawn and random functions.");
    }
    this.bridge = bridge;
    this.adapterScript = path.resolve(adapterScript);
    this.tempRoot = path.resolve(tempRoot);
    this.execPath = execPath;
    this.spawn = spawn;
    this.baseEnv = { ...baseEnv };
    this.random = random;
    this.readyTimeoutMs = readyTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.child = null;
    this.descriptorPath = null;
    this.token = null;
    this.policy = normalizePolicy();
    this.policyKey = policyIdentity(this.policy);
    this.status = "stopped";
    this.errorCode = null;
    this.generation = 0;
    this.startPromise = null;
    this.stopPromise = null;
    this.stoppingGeneration = null;
    this.retiredGeneration = 0;
  }

  getState() {
    return {
      enabled: this.policy.enabled,
      running: this.status === "running" && this.bridge.isRunning === true,
      status: this.status,
      error_code: this.errorCode,
      allowed_tools: this.policy.allowedTools.slice(),
      activity_cursor: Number.isSafeInteger(this.bridge.nextCursor) ? Math.max(0, this.bridge.nextCursor - 1) : 0,
    };
  }

  async sync(config = {}) {
    const policy = normalizePolicy(config);
    const nextKey = policyIdentity(policy);
    if (!policy.enabled) {
      this.policy = policy;
      this.policyKey = nextKey;
      await this.stop({ preservePolicy: true });
      return this.getState();
    }
    if (this.status === "running" && this.policyKey === nextKey) return this.getState();
    if (this.status === "starting" && this.policyKey === nextKey && this.startPromise) {
      await this.startPromise;
      return this.getState();
    }
    if (this.status === "running" || this.status === "starting") await this.stop({ preservePolicy: true });
    this.policy = policy;
    this.policyKey = nextKey;
    return await this.start();
  }

  async start() {
    if (!this.policy.enabled) return this.getState();
    if (this.status === "running") return this.getState();
    if (this.startPromise) return await this.startPromise;

    this.startPromise = this.#start();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async stop({ preservePolicy = false } = {}) {
    if (this.stopPromise) return await this.stopPromise;
    this.stopPromise = this.#stop({ preservePolicy });
    try {
      return await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  async #start() {
    const policy = this.policy;
    const generation = ++this.generation;
    this.status = "starting";
    this.errorCode = null;
    this.token = this.random(32).toString("hex");
    try {
      const descriptor = await this.bridge.start({
        enabled: true,
        profile: policy.profile,
        token: this.token,
        allowedRoots: policy.allowedRoots,
        allowedTools: policy.allowedTools,
        confirmationRequired: policy.confirmationRequired,
      });
      const descriptorPath = await this.#writeDescriptor(descriptor);
      this.descriptorPath = descriptorPath;
      const clientId = `main-${this.random(8).toString("hex")}`;
      const child = this.spawn(this.execPath, [this.adapterScript], {
        cwd: path.dirname(this.adapterScript),
        env: {
          ...this.baseEnv,
          ELECTRON_RUN_AS_NODE: "1",
          MOONSHINE_MCP_CONTROLLED: "1",
        },
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        windowsHide: true,
      });
      if (!child || typeof child.once !== "function") throw lifecycleError("MCP_ADAPTER_SPAWN_FAILED");
      this.child = child;
      this.#watchChild(child, generation);
      const ready = this.#waitForReady(child, generation);
      await this.#sendBootstrap(child, { descriptor, token: this.token, profile: policy.profile, clientId });
      await ready;
      if (generation !== this.generation || this.status !== "starting") throw lifecycleError("MCP_START_CANCELLED");
      this.status = "running";
      return this.getState();
    } catch (error) {
      const code = safeErrorCode(error?.code);
      this.errorCode = code;
      this.status = "failed";
      await this.#stopChildAndBridge({ preservePolicy: true, generation });
      throw lifecycleError(code);
    }
  }

  async #stop({ preservePolicy }) {
    const generation = this.generation;
    if (!this.child && !this.bridge.isRunning) {
      this.status = "stopped";
      this.errorCode = null;
      this.token = null;
      await this.#removeDescriptor();
      if (!preservePolicy) this.policy = normalizePolicy();
      return this.getState();
    }
    this.status = "stopping";
    this.errorCode = null;
    await this.#stopChildAndBridge({ preservePolicy, generation });
    this.status = "stopped";
    return this.getState();
  }

  async #stopChildAndBridge({ preservePolicy, generation }) {
    this.stoppingGeneration = generation;
    this.retiredGeneration = Math.max(this.retiredGeneration, generation);
    const child = this.child;
    this.child = null;
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill?.("SIGTERM");
        } catch {
          // The adapter is being torn down; bridge shutdown still revokes access.
        }
        const exitedAfterTerminate = await waitForExit(child, this.stopTimeoutMs);
        if (!exitedAfterTerminate && child.exitCode === null && child.signalCode === null) {
          try {
            child.kill?.("SIGKILL");
          } catch {
            // The bridge still stops below, revoking the adapter's only useful connection.
          }
          await waitForExit(child, this.stopTimeoutMs);
        }
      }
      await this.bridge.stop();
    } finally {
      this.token = null;
      await this.#removeDescriptor();
      if (!preservePolicy) this.policy = normalizePolicy();
      this.stoppingGeneration = null;
    }
  }

  async #writeDescriptor(descriptor) {
    await mkdir(this.tempRoot, { recursive: true, mode: 0o700 });
    await chmod(this.tempRoot, 0o700).catch(() => null);
    const filename = `descriptor-${this.random(16).toString("hex")}.json`;
    const descriptorPath = path.join(this.tempRoot, filename);
    await writeFile(descriptorPath, JSON.stringify(descriptor), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(descriptorPath, 0o600).catch(() => null);
    return descriptorPath;
  }

  async #removeDescriptor() {
    const descriptorPath = this.descriptorPath;
    this.descriptorPath = null;
    if (descriptorPath) await rm(descriptorPath, { force: true }).catch(() => null);
  }

  #watchChild(child, generation) {
    child.once("error", () => this.#handleUnexpectedExit(generation, "MCP_ADAPTER_SPAWN_FAILED"));
    child.once("exit", () => this.#handleUnexpectedExit(generation, "MCP_ADAPTER_EXITED"));
  }

  #sendBootstrap(child, payload) {
    if (typeof child.send !== "function") return Promise.reject(lifecycleError("MCP_ADAPTER_CONTROL_UNAVAILABLE"));
    return new Promise((resolve, reject) => {
      try {
        child.send({ type: "moonshine-mcp-bootstrap", ...payload }, (error) => {
          if (error) reject(lifecycleError("MCP_ADAPTER_CONTROL_UNAVAILABLE"));
          else resolve();
        });
      } catch {
        reject(lifecycleError("MCP_ADAPTER_CONTROL_UNAVAILABLE"));
      }
    });
  }

  #handleUnexpectedExit(generation, code) {
    if (
      generation !== this.generation ||
      generation <= this.retiredGeneration ||
      this.stoppingGeneration === generation
    ) return;
    this.child = null;
    this.status = "failed";
    this.errorCode = code;
    this.token = null;
    void this.bridge.stop().catch(() => null);
    void this.#removeDescriptor();
  }

  #waitForReady(child, generation) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off?.("message", onMessage);
        child.off?.("error", onError);
        child.off?.("exit", onExit);
        error ? reject(error) : resolve();
      };
      const onMessage = (message) => {
        if (!message || typeof message !== "object") return;
        if (message.type === READY_MESSAGE) return finish();
        if (message.type === FAILED_MESSAGE) return finish(lifecycleError(safeErrorCode(message.code)));
      };
      const onError = () => finish(lifecycleError("MCP_ADAPTER_SPAWN_FAILED"));
      const onExit = () => finish(lifecycleError("MCP_ADAPTER_EXITED"));
      const timer = setTimeout(() => finish(lifecycleError("MCP_ADAPTER_READY_TIMEOUT")), this.readyTimeoutMs);
      if (generation !== this.generation) return finish(lifecycleError("MCP_START_CANCELLED"));
      child.once("error", onError);
      child.once("exit", onExit);
      child.on?.("message", onMessage);
    });
  }
}
