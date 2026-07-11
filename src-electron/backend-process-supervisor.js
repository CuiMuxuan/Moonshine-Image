import { StringDecoder } from "node:string_decoder";

import { truncateUtf8Tail } from "./startup-diagnostics.js";

const DEFAULT_OUTPUT_TAIL_LIMIT = 32 * 1024;

function defaultDecodeOutput(data) {
  if (data === undefined || data === null) return "";
  return Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
}

function appendTail(current, next, limit = DEFAULT_OUTPUT_TAIL_LIMIT) {
  const combined = `${current || ""}${next || ""}`;
  return truncateUtf8Tail(combined, limit);
}

function createOutputStreamState() {
  return {
    decoder: new StringDecoder("utf8"),
    pendingLine: "",
    flushed: false,
  };
}

function defaultFailure(input = {}) {
  const diagnostic = {
    id: input.id || `startup-${Date.now()}`,
    code: input.code || "BACKEND_PROCESS_FAILED",
    stage: input.stage || "backend-service",
    reason: input.reason || "process-error",
    commandLine: input.commandLine || "",
    cwd: input.cwd || "",
    osCode: input.osCode || null,
    exitCode: input.exitCode ?? null,
    signal: input.signal || null,
    timedOut: input.timedOut === true,
    durationMs: input.durationMs ?? null,
    stdoutTail: input.stdoutTail || "",
    stderrTail: input.stderrTail || "",
    attempts: input.attempts || [],
    timestamp: new Date().toISOString(),
  };
  return {
    success: false,
    code: diagnostic.code,
    error: input.error || "Backend service failed.",
    recoveryHint: input.recoveryHint || "Open the startup log for details.",
    diagnostic,
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BackendProcessSupervisor {
  constructor(options = {}) {
    if (typeof options.spawnImpl !== "function") {
      throw new TypeError("BackendProcessSupervisor requires spawnImpl.");
    }
    if (typeof options.probeReady !== "function") {
      throw new TypeError("BackendProcessSupervisor requires probeReady.");
    }

    this.spawnImpl = options.spawnImpl;
    this.probeReady = options.probeReady;
    this.terminateProcess =
      options.terminateProcess ||
      ((child, { force = false } = {}) => child.kill(force ? "SIGKILL" : "SIGTERM"));
    this.createFailure = options.createFailure || defaultFailure;
    this.onOutput = options.onOutput || (() => {});
    this.onState = options.onState || (() => {});
    this.decodeOutput = options.decodeOutput || defaultDecodeOutput;
    this.now = options.now || Date.now;
    this.sleep = options.sleep || defaultSleep;
    this.setTimer = options.setTimeoutImpl || setTimeout;
    this.clearTimer = options.clearTimeoutImpl || clearTimeout;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 120000;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.outputTailLimit = options.outputTailLimit ?? DEFAULT_OUTPUT_TAIL_LIMIT;

    this.state = "stopped";
    this.current = null;
    this.generation = 0;
    this.startPromise = null;
    this.stopPromise = null;
    this.startedAt = null;
    this.readyAt = null;
    this.lastExit = null;
    this.lastError = null;
    this.lastFailure = null;
  }

  getStatus() {
    const record = this.current;
    const ready = this.state === "running" && Boolean(record && !record.closed);
    return {
      success: true,
      state: this.state,
      processRunning: Boolean(record && !record.closed),
      ready,
      running: ready,
      pid: record?.child?.pid || null,
      port: record?.port || null,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      lastExit: this.lastExit,
      lastError: this.lastError,
      code: this.lastFailure?.code || this.lastError?.code || null,
      error: this.lastFailure?.error || null,
      recoveryHint: this.lastFailure?.recoveryHint || null,
      diagnostic: this.lastFailure?.diagnostic || this.lastError || null,
    };
  }

  async start(spec = {}) {
    const stopInProgress = this.stopPromise;
    const startBeingStopped = stopInProgress ? this.startPromise : null;
    if (stopInProgress) {
      const stopResult = await stopInProgress;
      if (!stopResult.success) return stopResult;
      if (startBeingStopped) await startBeingStopped;
    }

    if (this.state === "running" && this.current && !this.current.closed) {
      return {
        success: true,
        ready: true,
        alreadyRunning: true,
        port: this.current.port,
        pid: this.current.child?.pid || null,
      };
    }
    if (this.startPromise) return await this.startPromise;

    if (this.current && !this.current.closed) {
      const stopResult = await this.stop();
      if (!stopResult.success) return stopResult;
      if (this.startPromise) return await this.startPromise;
    }

    const pending = Promise.resolve().then(() => this._start(spec));
    this.startPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.startPromise === pending) this.startPromise = null;
    }
  }

  async _start(spec) {
    const generation = ++this.generation;
    const startedAtMs = this.now();
    this.startedAt = new Date(startedAtMs).toISOString();
    this.readyAt = null;
    this.lastError = null;
    this.lastFailure = null;
    this.state = "starting";
    this._emitState();

    let child;
    try {
      child = this.spawnImpl(spec.command, spec.args || [], {
        cwd: spec.cwd,
        env: spec.env,
        stdio: "pipe",
        ...(spec.spawnOptions || {}),
      });
    } catch (error) {
      return this._failWithoutChild(spec, startedAtMs, error);
    }

    const record = {
      generation,
      child,
      command: spec.command,
      args: spec.args || [],
      cwd: spec.cwd || "",
      port: spec.port,
      requestedPort: spec.requestedPort,
      startedAtMs,
      stdoutTail: "",
      stderrTail: "",
      outputStreams: {
        stdout: createOutputStreamState(),
        stderr: createOutputStreamState(),
      },
      closed: false,
      expectedStop: false,
      stopRequested: false,
      abortController: new AbortController(),
      startupSettled: false,
      settleStartup: null,
      startupPromise: null,
      closeSettled: false,
      settleClose: null,
      closePromise: null,
      terminationAttempts: [],
    };
    record.startupPromise = new Promise((resolve) => {
      record.settleStartup = resolve;
    });
    record.closePromise = new Promise((resolve) => {
      record.settleClose = resolve;
    });
    this.current = record;

    child.stdout?.on("data", (data) => this._handleOutput(record, "stdout", data));
    child.stderr?.on("data", (data) => this._handleOutput(record, "stderr", data));
    child.once("error", (error) => this._handleSpawnError(record, error));
    child.once("close", (code, signal) => this._handleClose(record, code, signal));

    const outcome = await Promise.race([
      record.startupPromise,
      this._waitUntilReady(record),
    ]);

    if (
      outcome.kind === "ready" &&
      this.current === record &&
      !record.closed &&
      !record.expectedStop &&
      this.state === "starting"
    ) {
      this.state = "running";
      this.readyAt = new Date(this.now()).toISOString();
      this._emitState();
      return {
        success: true,
        ready: true,
        port: record.port,
        requestedPort: record.requestedPort,
        pid: child.pid || null,
      };
    }

    record.abortController.abort();
    if (
      outcome.kind === "cancelled" ||
      record.stopRequested ||
      this.current !== record
    ) {
      return this._cancelledStart(record);
    }

    if (outcome.kind === "timeout" && this.current === record) {
      record.expectedStop = true;
      await this._terminateRecord(record);
      if (record.stopRequested) return this._cancelledStart(record);
      const failure = this._buildFailure(record, {
        code: "BACKEND_START_TIMEOUT",
        reason: "timeout",
        timedOut: true,
        error: "Backend service did not become ready in time.",
        recoveryHint: "Check the startup log, model files, and security software, then retry.",
      });
      this.lastError = failure.diagnostic;
      this.lastFailure = failure;
      if (this.current === record && record.closed) this.current = null;
      this.state = "failed";
      this._emitState(failure.diagnostic);
      return failure;
    }

    if (record.expectedStop) return this._cancelledStart(record);

    const failure = this._buildFailure(record, {
      code:
        outcome.kind === "spawn-error"
          ? "BACKEND_PROCESS_SPAWN_FAILED"
          : "BACKEND_EXITED_BEFORE_READY",
      reason: outcome.kind,
      error:
        outcome.kind === "spawn-error"
          ? "Backend process could not be started."
          : "Backend process exited before its API became ready.",
      osCode: outcome.error?.code,
      exitCode: outcome.code,
      signal: outcome.signal,
    });
    this.lastError = failure.diagnostic;
    this.lastFailure = failure;
    if (this.current === record) this.current = null;
    this.state = "failed";
    this._emitState(failure.diagnostic);
    return failure;
  }

  async _waitUntilReady(record) {
    const signal = record.abortController.signal;
    let timeoutTimer;
    let removeAbortListener = () => {};
    const cancelled = new Promise((resolve) => {
      const onAbort = () => resolve({ kind: "cancelled" });
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    });
    const timedOut = new Promise((resolve) => {
      timeoutTimer = this.setTimer(
        () => resolve({ kind: "timeout" }),
        this.readinessTimeoutMs,
      );
      timeoutTimer?.unref?.();
    });
    const polling = (async () => {
      while (!signal.aborted && this.current === record) {
        try {
          const ready = await this.probeReady(record.port, {
            signal,
            generation: record.generation,
          });
          if (ready) return { kind: "ready" };
        } catch (error) {
          if (signal.aborted) return { kind: "cancelled" };
          record.lastProbeError = error;
        }
        if (signal.aborted || this.current !== record) return { kind: "cancelled" };
        await this.sleep(this.pollIntervalMs);
      }
      return { kind: "cancelled" };
    })();

    try {
      return await Promise.race([polling, cancelled, timedOut]);
    } finally {
      this.clearTimer(timeoutTimer);
      removeAbortListener();
    }
  }

  _handleOutput(record, stream, data) {
    if (this.current !== record || record.closed) return;
    const streamState = record.outputStreams?.[stream];
    if (!streamState || streamState.flushed) return;
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ""));
    const message = this.decodeOutput(streamState.decoder.write(buffer));
    this._consumeOutput(record, stream, message);
  }

  _consumeOutput(record, stream, message, options = {}) {
    const streamState = record.outputStreams?.[stream];
    if (!streamState) return;
    const text = String(message ?? "");
    if (stream === "stderr") {
      record.stderrTail = appendTail(record.stderrTail, text, this.outputTailLimit);
    } else {
      record.stdoutTail = appendTail(record.stdoutTail, text, this.outputTailLimit);
    }

    const buffered = `${streamState.pendingLine}${text}`;
    let lineStart = 0;
    let index = 0;
    while (index < buffered.length) {
      const character = buffered[index];
      if (character !== "\n" && character !== "\r") {
        index += 1;
        continue;
      }
      if (character === "\r" && index + 1 === buffered.length && !options.flush) break;

      if (options.emit !== false) {
        this._emitOutputLine(record, stream, buffered.slice(lineStart, index));
      }
      index += character === "\r" && buffered[index + 1] === "\n" ? 2 : 1;
      lineStart = index;
    }

    streamState.pendingLine = buffered.slice(lineStart);
    if (options.flush && streamState.pendingLine) {
      if (options.emit !== false) {
        this._emitOutputLine(record, stream, streamState.pendingLine);
      }
      streamState.pendingLine = "";
    }
  }

  _emitOutputLine(record, stream, message) {
    let type = "info";
    if (stream === "stderr" && /\b(?:ERROR|CRITICAL|FATAL)\b|Traceback/i.test(message)) {
      type = "error";
    } else if (/\bWARN(?:ING)?\b/i.test(message)) {
      type = "warning";
    }
    this.onOutput({
      message,
      type,
      stream,
      stage: this.state === "starting" ? "backend-start" : "backend-run",
      timestamp: new Date().toISOString(),
      diagnosticId: record.diagnosticId || null,
    });
  }

  _flushOutput(record) {
    const emit = this.current === record;
    for (const stream of ["stdout", "stderr"]) {
      const streamState = record.outputStreams?.[stream];
      if (!streamState || streamState.flushed) continue;
      streamState.flushed = true;
      const finalMessage = this.decodeOutput(streamState.decoder.end());
      this._consumeOutput(record, stream, finalMessage, { emit, flush: true });
    }
  }

  _settleStartup(record, outcome) {
    if (record.startupSettled) return false;
    record.startupSettled = true;
    record.settleStartup?.(outcome);
    return true;
  }

  _settleClose(record, outcome) {
    if (record.closeSettled) return false;
    record.closeSettled = true;
    record.closeOutcome = outcome;
    record.settleClose?.(outcome);
    return true;
  }

  _handleSpawnError(record, error) {
    record.spawnError = error;
    this._settleStartup(record, { kind: "spawn-error", error });
    if (this.current === record && this.state === "running") {
      const failure = this._buildFailure(record, {
        code: "BACKEND_PROCESS_FAILED",
        stage: "backend-run",
        reason: "spawn-error",
        error: "Backend process failed after startup.",
        osCode: error?.code,
      });
      record.failureHandled = true;
      this.lastError = failure.diagnostic;
      this.lastFailure = failure;
      this.state = "failed";
      this.readyAt = null;
      this._emitState(failure.diagnostic);
    }
  }

  _handleClose(record, code, signal) {
    this._flushOutput(record);
    record.closed = true;
    record.abortController.abort();
    const exit = {
      code: code ?? null,
      signal: signal || null,
      expected: record.expectedStop,
      timestamp: new Date().toISOString(),
    };
    this._settleClose(record, { kind: "close", code, signal });
    this._settleStartup(record, { kind: "close", code, signal });
    if (this.current !== record) return;
    this.lastExit = exit;

    if (record.stopRequested || this.state === "stopping") {
      this.current = null;
      this.state = "stopped";
      this.readyAt = null;
      this._emitState(null, true);
      return;
    }
    if (record.expectedStop) {
      this.current = null;
      this.readyAt = null;
      return;
    }
    if (this.state === "starting") return;
    if (record.failureHandled) {
      this.current = null;
      this.readyAt = null;
      this._emitState(this.lastError);
      return;
    }

    const failure = this._buildFailure(record, {
      code: "BACKEND_PROCESS_EXITED",
      stage: "backend-run",
      reason: "unexpected-exit",
      error: "Backend service stopped unexpectedly.",
      exitCode: code,
      signal,
    });
    this.lastError = failure.diagnostic;
    this.lastFailure = failure;
    this.current = null;
    this.state = "failed";
    this.readyAt = null;
    const stderrTail = record.stderrTail.trim();
    this.onOutput({
      type: "error",
      stream: "lifecycle",
      stage: "backend-run",
      timestamp: new Date().toISOString(),
      diagnosticId: failure.diagnostic?.id,
      stderrTail: record.stderrTail,
      message: [
        `Backend service stopped unexpectedly (exit code: ${code ?? "unknown"}).`,
        stderrTail,
      ]
        .filter(Boolean)
        .join("\n"),
    });
    this._emitState(failure.diagnostic);
  }

  async stop() {
    if (this.stopPromise) return await this.stopPromise;
    const pending = Promise.resolve().then(() => this._stop());
    this.stopPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.stopPromise === pending) this.stopPromise = null;
    }
  }

  async _stop() {
    const record = this.current;
    if (!record || record.closed) {
      this.current = null;
      this.state = "stopped";
      this.readyAt = null;
      this._emitState(null, true);
      return { success: true, alreadyStopped: true };
    }

    record.expectedStop = true;
    record.stopRequested = true;
    record.abortController.abort();
    this._settleStartup(record, { kind: "cancelled" });
    this.state = "stopping";
    this._emitState(null, true);

    const gracefulResult = await this._terminateAndWait(record, false, 5000);
    if (gracefulResult.kind !== "close") {
      this.onOutput({
        type: "warning",
        stream: "lifecycle",
        stage: "backend-stop",
        timestamp: new Date().toISOString(),
        diagnosticId: record.diagnosticId || null,
        message: "Backend service did not stop gracefully; forcing termination.",
      });
      const forcedResult = await this._terminateAndWait(record, true, 5000);
      if (forcedResult.kind !== "close") {
        const failure = this._buildFailure(record, {
          code: "BACKEND_STOP_FAILED",
          reason: "timeout",
          timedOut: true,
          error: "Backend service could not be stopped.",
          recoveryHint: "Close the application and terminate the recorded process manually.",
        });
        this.lastError = failure.diagnostic;
        this.lastFailure = failure;
        this.state = "failed";
        this._emitState(failure.diagnostic);
        return failure;
      }
    }

    if (this.current === record) {
      this.current = null;
      this.state = "stopped";
      this.readyAt = null;
      this._emitState(null, true);
    } else if (!this.current && this.state !== "stopped") {
      this.state = "stopped";
      this.readyAt = null;
      this._emitState(null, true);
    }
    return { success: true };
  }

  async _terminateAndWait(record, force, timeoutMs) {
    if (record.closed) return record.closeOutcome || { kind: "close" };
    const abortController = new AbortController();
    let terminationPromise;
    try {
      terminationPromise = Promise.resolve(
        this.terminateProcess(record.child, {
          force,
          record,
          signal: abortController.signal,
        }),
      );
    } catch (error) {
      terminationPromise = Promise.reject(error);
    }
    terminationPromise = terminationPromise.catch((error) => {
      record.terminationError = error;
      record.terminationAttempts.push(
        error?.diagnostic || {
          stage: force ? "backend-force-stop" : "backend-stop",
          reason: error?.message || String(error),
          osCode: error?.code || null,
          exitCode: error?.exitCode ?? null,
          stderrTail: error?.stderrTail || error?.stderr || "",
        },
      );
    });
    const result = await this._waitForClose(record, timeoutMs, () => {
      abortController.abort(new Error("Backend termination phase timed out."));
    });
    if (result.kind === "timeout") {
      await terminationPromise;
    }
    return result;
  }

  async _waitForClose(record, timeoutMs, onTimeout = null) {
    if (record.closed) return record.closeOutcome || { kind: "close" };
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        this.clearTimer(timer);
        resolve(result);
      };
      const timer = this.setTimer(() => {
        onTimeout?.();
        finish({ kind: "timeout" });
      }, timeoutMs);
      timer?.unref?.();
      record.closePromise.then(finish);
    });
  }

  async _terminateRecord(record) {
    const graceful = await this._terminateAndWait(record, false, 3000);
    if (graceful.kind === "timeout") {
      await this._terminateAndWait(record, true, 2000);
    }
  }

  async restart(spec = {}) {
    const stopResult = await this.stop();
    if (!stopResult.success) return stopResult;
    return await this.start(spec);
  }

  _cancelledStart(record) {
    const failure = this._buildFailure(record, {
      code: "BACKEND_START_CANCELLED",
      reason: "cancelled",
      error: "Backend startup was cancelled.",
      recoveryHint: "No action is required.",
    });
    return {
      ...failure,
      cancelled: true,
      expected: true,
    };
  }

  _failWithoutChild(spec, startedAtMs, error) {
    const failure = this.createFailure({
      code: "BACKEND_PROCESS_SPAWN_FAILED",
      stage: "backend-start",
      reason: "spawn-error",
      commandLine: [spec.command, ...(spec.args || [])].filter(Boolean).join(" "),
      cwd: spec.cwd || "",
      osCode: error?.code,
      durationMs: this.now() - startedAtMs,
      error: "Backend process could not be started.",
      recoveryHint: "Check the runtime files, permissions, and security software.",
    });
    this.lastError = failure.diagnostic;
    this.lastFailure = failure;
    this.state = "failed";
    this._emitState(failure.diagnostic);
    return failure;
  }

  _buildFailure(record, overrides = {}) {
    const terminationDiagnostics = record.terminationAttempts.filter(
      (attempt) => attempt && typeof attempt === "object",
    );
    const latestValue = (key) => {
      for (let index = terminationDiagnostics.length - 1; index >= 0; index -= 1) {
        const value = terminationDiagnostics[index]?.[key];
        if (value !== undefined && value !== null && value !== "") return value;
      }
      return undefined;
    };
    const collectTail = (initial, key) => {
      let tail = initial || "";
      for (const diagnostic of terminationDiagnostics) {
        const value = diagnostic?.[key];
        if (!value) continue;
        const separator = tail && !tail.endsWith("\n") ? "\n" : "";
        tail = appendTail(tail, `${separator}${value}`, this.outputTailLimit);
      }
      return tail;
    };
    return this.createFailure({
      id: record.diagnosticId,
      code: overrides.code,
      stage: overrides.stage || "backend-start",
      reason: overrides.reason,
      commandLine:
        overrides.commandLine ||
        latestValue("commandLine") ||
        [record.command, ...record.args].filter(Boolean).join(" "),
      cwd: overrides.cwd || latestValue("cwd") || record.cwd,
      osCode:
        overrides.osCode ||
        latestValue("osCode") ||
        record.terminationError?.code,
      exitCode: overrides.exitCode ?? latestValue("exitCode"),
      signal: overrides.signal || latestValue("signal"),
      timedOut: overrides.timedOut,
      durationMs: this.now() - record.startedAtMs,
      stdoutTail: collectTail(record.stdoutTail, "stdoutTail"),
      stderrTail: collectTail(record.stderrTail, "stderrTail"),
      attempts: record.terminationAttempts,
      error: overrides.error,
      recoveryHint:
        overrides.recoveryHint || "Open the startup log and review the final error output.",
    });
  }

  _emitState(diagnostic = null, expected = false) {
    const status = this.getStatus();
    const failure =
      diagnostic && this.lastFailure?.diagnostic?.id === diagnostic.id
        ? this.lastFailure
        : null;
    this.onState({
      state: status.state,
      processRunning: status.processRunning,
      ready: status.ready,
      running: status.running,
      pid: status.pid,
      port: status.port,
      startedAt: status.startedAt,
      readyAt: status.readyAt,
      lastExit: status.lastExit,
      lastError: status.lastError,
      code: failure?.code || diagnostic?.code || null,
      error: failure?.error || null,
      recoveryHint: failure?.recoveryHint || null,
      expected,
      diagnostic,
      timestamp: new Date().toISOString(),
    });
  }
}

export const BACKEND_OUTPUT_TAIL_LIMIT = DEFAULT_OUTPUT_TAIL_LIMIT;
