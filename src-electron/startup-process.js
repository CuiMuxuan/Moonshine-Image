import { spawn as nodeSpawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import {
  createDiagnostic,
  formatCommandLine,
  getRecoveryHint,
  StartupProcessError,
  truncateUtf8Tail,
} from "./startup-diagnostics.js";

const PROCESS_OPTION_KEYS = [
  "cwd",
  "env",
  "stdio",
  "shell",
  "windowsHide",
  "detached",
  "uid",
  "gid",
  "serialization",
];
const DEFAULT_CAPTURE_LIMIT_BYTES = 4 * 1024 * 1024;

function invokeCallback(callback, args, onCallbackError) {
  if (typeof callback !== "function") return;
  try {
    callback(...args);
  } catch (error) {
    if (typeof onCallbackError === "function") {
      try {
        onCallbackError(error);
      } catch {
        // Output observers cannot be allowed to break process supervision.
      }
    }
  }
}

function createOutputCapture(encoding, onData, onCallbackError, stream, maxCaptureBytes) {
  const decoder = new StringDecoder(encoding);
  let output = "";
  let finished = false;

  return {
    push(chunk) {
      if (finished) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding);
      const text = decoder.write(buffer);
      if (!text) return;
      output = truncateUtf8Tail(`${output}${text}`, maxCaptureBytes);
      invokeCallback(onData, [text, { stream }], (error) =>
        invokeCallback(onCallbackError, [error, { stream }])
      );
    },
    finish() {
      if (finished) return output;
      finished = true;
      const text = decoder.end();
      if (text) {
        output = truncateUtf8Tail(`${output}${text}`, maxCaptureBytes);
        invokeCallback(onData, [text, { stream }], (error) =>
          invokeCallback(onCallbackError, [error, { stream }])
        );
      }
      return output;
    },
    value() {
      return output;
    },
    tail() {
      return truncateUtf8Tail(output);
    },
  };
}

function resolveDuration(startedAt, now) {
  return Math.max(0, Number(now()) - startedAt);
}

function resolveFailureCode(kind, options) {
  if (options.failureCode) return options.failureCode;
  if (kind === "spawn") return options.spawnFailureCode || "PROCESS_SPAWN_FAILED";
  if (kind === "timeout") return options.timeoutCode || "PROCESS_TIMEOUT";
  if (kind === "abort") return options.abortCode || "PROCESS_ABORTED";
  return options.exitFailureCode || "PROCESS_EXIT_NON_ZERO";
}

function resolveUserMessage(kind, options) {
  if (options.userMessage || options.errorMessage) {
    return options.userMessage || options.errorMessage;
  }
  if (kind === "spawn") return "无法启动所需的程序。";
  if (kind === "timeout") return "程序执行超时。";
  if (kind === "abort") return "操作已取消。";
  return "程序执行失败。";
}

function makeReason(kind, commandLine, details = {}) {
  if (kind === "spawn") {
    return details.error?.message || `Failed to spawn ${commandLine}.`;
  }
  if (kind === "timeout") {
    return `${commandLine} timed out after ${details.timeoutMs} ms.`;
  }
  if (kind === "abort") {
    const reason = details.abortReason;
    return reason ? `${commandLine} was aborted: ${String(reason)}` : `${commandLine} was aborted.`;
  }
  const suffix = details.signal
    ? ` after receiving signal ${details.signal}`
    : ` with exit code ${details.exitCode}`;
  return `${commandLine} exited${suffix}.`;
}

function createProcessFailure(kind, context, details = {}) {
  const code = resolveFailureCode(kind, context.options);
  const userMessage = resolveUserMessage(kind, context.options);
  const stdout = context.stdout.value();
  const stderr = context.stderr.value();
  const durationMs = resolveDuration(context.startedAt, context.now);
  const reason = makeReason(kind, context.commandLine, details);
  const terminationAttempt = details.terminationError?.diagnostic ||
    (details.terminationError
      ? {
          stage: "process-termination",
          reason: details.terminationError.message || String(details.terminationError),
          osCode: details.terminationError.code || null,
        }
      : null);
  const attempts = [
    ...(Array.isArray(context.options.attempts) ? context.options.attempts : []),
    ...(terminationAttempt ? [terminationAttempt] : []),
  ];
  const diagnostic = createDiagnostic({
    code,
    stage: context.options.stage || "process",
    reason,
    commandLine: context.commandLine,
    cwd: context.childOptions.cwd,
    error: details.error || details.terminationError,
    exitCode: details.exitCode,
    signal: details.signal,
    timedOut: kind === "timeout",
    durationMs,
    stdout,
    stderr,
    attempts,
    logPath: context.options.logPath,
  });

  return new StartupProcessError(userMessage, {
    cause: details.error,
    userMessage,
    recoveryHint: getRecoveryHint(code, context.options.recoveryHint),
    diagnostic,
  });
}

function buildChildOptions(options) {
  const childOptions = {
    stdio: ["ignore", "pipe", "pipe"],
    ...(options.spawnOptions || {}),
  };
  for (const key of PROCESS_OPTION_KEYS) {
    if (options[key] !== undefined) childOptions[key] = options[key];
  }
  return childOptions;
}

function normalizeSuccessExitCodes(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  if (value !== undefined && value !== null) return new Set([value]);
  return new Set([0]);
}

/**
 * Runs a short-lived child process and rejects with StartupProcessError on failure.
 * Long-lived services should retain their child reference and use their own supervisor.
 */
export function runStartupProcess(command, args = [], options = {}) {
  const processArgs = Array.isArray(args) ? args.map(String) : [];
  const spawnImpl = options.spawnImpl || nodeSpawn;
  const now = options.now || Date.now;
  const startedAt = Number(now());
  const commandLine = formatCommandLine(command, processArgs);
  const childOptions = buildChildOptions(options);
  const maxCaptureBytes = Math.max(
    32 * 1024,
    Number(options.maxCaptureBytes) || DEFAULT_CAPTURE_LIMIT_BYTES
  );
  const stdout = createOutputCapture(
    options.encoding || "utf8",
    options.onStdout,
    options.onCallbackError,
    "stdout",
    maxCaptureBytes
  );
  const stderr = createOutputCapture(
    options.encoding || "utf8",
    options.onStderr,
    options.onCallbackError,
    "stderr",
    maxCaptureBytes
  );
  const context = {
    options,
    now,
    startedAt,
    commandLine,
    childOptions,
    stdout,
    stderr,
  };

  if (options.signal?.aborted) {
    return Promise.reject(
      createProcessFailure("abort", context, {
        abortReason: options.signal.reason,
      })
    );
  }

  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let streamsFinished = false;
    let timeoutId = null;
    let terminationKind = null;
    let terminationDetails = null;
    const timeoutMs = Number(options.timeoutMs ?? options.timeout);
    const setTimer = options.setTimeoutImpl || setTimeout;
    const clearTimer = options.clearTimeoutImpl || clearTimeout;
    const successExitCodes = normalizeSuccessExitCodes(options.successExitCodes);

    const finishStreams = () => {
      if (streamsFinished) {
        return { stdout: stdout.value(), stderr: stderr.value() };
      }
      streamsFinished = true;
      return { stdout: stdout.finish(), stderr: stderr.finish() };
    };

    const cleanup = () => {
      if (timeoutId !== null) {
        clearTimer(timeoutId);
        timeoutId = null;
      }
      options.signal?.removeEventListener?.("abort", handleAbort);
    };

    const settle = (action, value) => {
      if (settled) return false;
      settled = true;
      cleanup();
      action(value);
      return true;
    };

    const terminate = async () => {
      if (!child || typeof child.kill !== "function") return;
      if (typeof options.terminateProcess === "function") {
        await options.terminateProcess(child, {
          reason: terminationKind,
          killSignal: options.killSignal || "SIGTERM",
        });
        return;
      }

      const killSignal = options.killSignal || "SIGTERM";
      const signalSent = child.kill(killSignal);
      if (signalSent === false) {
        const error = new Error(`Failed to send ${killSignal} to child process.`);
        error.code = "PROCESS_TERMINATION_FAILED";
        throw error;
      }
    };

    const finishTermination = () => {
      if (settled || !terminationKind) return;
      finishStreams();
      settle(
        reject,
        createProcessFailure(terminationKind, context, terminationDetails || {})
      );
    };

    const beginTermination = (kind, details = {}) => {
      if (settled || terminationKind) return;
      terminationKind = kind;
      terminationDetails = details;
      cleanup();
      Promise.resolve()
        .then(terminate)
        .catch((error) => {
          terminationDetails = { ...terminationDetails, terminationError: error };
          invokeCallback(
            options.onCallbackError,
            [error, { stream: "process", operation: "terminate" }]
          );
        })
        .finally(finishTermination);
    };

    function handleAbort() {
      beginTermination("abort", {
        abortReason: options.signal?.reason,
      });
    }

    try {
      child = spawnImpl(command, processArgs, childOptions);
    } catch (error) {
      finishStreams();
      settle(reject, createProcessFailure("spawn", context, { error }));
      return;
    }

    child.stdout?.on?.("data", (chunk) => stdout.push(chunk));
    child.stderr?.on?.("data", (chunk) => stderr.push(chunk));

    child.once("error", (error) => {
      if (settled || terminationKind) return;
      finishStreams();
      settle(reject, createProcessFailure("spawn", context, { error }));
    });

    child.once("close", (exitCode, signal) => {
      if (settled) return;
      if (terminationKind) {
        // The process can close before an asynchronous process-tree terminator
        // finishes. Let the terminator settle first so its failure is preserved.
        finishStreams();
        return;
      }
      const output = finishStreams();
      const durationMs = resolveDuration(startedAt, now);
      if (successExitCodes.has(exitCode)) {
        settle(resolve, {
          success: true,
          code: exitCode,
          exitCode,
          signal: signal ?? null,
          stdout: output.stdout,
          stderr: output.stderr,
          stdoutTail: stdout.tail(),
          stderrTail: stderr.tail(),
          durationMs,
          commandLine,
        });
        return;
      }

      settle(reject, createProcessFailure("exit", context, {
        exitCode,
        signal,
      }));
    });

    options.signal?.addEventListener?.("abort", handleAbort, { once: true });
    if (options.signal?.aborted) {
      handleAbort();
      return;
    }

    invokeCallback(options.onSpawn, [child], (error) =>
      invokeCallback(options.onCallbackError, [error, { stream: "process", operation: "spawn" }])
    );
    if (settled || terminationKind) return;

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutId = setTimer(() => {
        beginTermination("timeout", { timeoutMs });
      }, timeoutMs);
    }
  });
}

export const execStartupProcess = runStartupProcess;
