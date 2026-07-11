import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const STARTUP_OUTPUT_TAIL_BYTES = 32 * 1024;
export const STARTUP_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const STARTUP_LOG_BACKUP_COUNT = 2;
export const REDACTED_VALUE = "[REDACTED]";

const SENSITIVE_OPTION_PATTERN = /(?:password|passwd|pwd|token|secret|key)/i;
const ENVIRONMENT_FIELD_PATTERN = /^(?:env|environment|processenv)$/i;

const DEFAULT_RECOVERY_HINTS = Object.freeze({
  PROCESS_SPAWN_FAILED: "请确认相关程序已完整安装，且当前用户有权执行该文件。",
  PROCESS_EXIT_NON_ZERO: "请查看启动日志中的退出码和错误输出，并按提示修复后重试。",
  PROCESS_TIMEOUT: "进程在限定时间内没有完成。请关闭占用资源的程序后重试。",
  PROCESS_ABORTED: "操作已取消。请确认没有其他启动或停止操作正在进行后重试。",
  STARTUP_FAILED: "请打开启动日志查看详细原因后重试。",
});

function stringValue(value) {
  if (value === undefined || value === null) return "";
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value);
}

function isSensitiveOptionName(value) {
  const normalized = stringValue(value)
    .replace(/^[-/]+/, "")
    .replace(/[=:].*$/s, "");
  return SENSITIVE_OPTION_PATTERN.test(normalized);
}

function quoteCommandPart(value) {
  const text = stringValue(value);
  if (!text) return '""';
  if (!/[\s"']/u.test(text)) return text;
  return JSON.stringify(text);
}

export function truncateUtf8Tail(value, maxBytes = STARTUP_OUTPUT_TAIL_BYTES) {
  const byteLimit = Math.max(0, Number.isFinite(maxBytes) ? Math.floor(maxBytes) : 0);
  if (byteLimit === 0) return "";

  const buffer = Buffer.isBuffer(value)
    ? value
    : Buffer.from(stringValue(value), "utf8");
  if (buffer.length <= byteLimit) return buffer.toString("utf8");

  let start = buffer.length - byteLimit;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return buffer.subarray(start).toString("utf8");
}

export function redactSensitiveText(value) {
  let text = stringValue(value);

  text = text.replace(
    /((?:password|passwd|pwd|token|secret|\b[a-z0-9_-]{0,64}key\b)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]*)/giu,
    `$1${REDACTED_VALUE}`
  );
  text = text.replace(
    /((?:--?|\/)(?:password|passwd|pwd|token|secret|[a-z0-9_-]{0,64}key)\b\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/giu,
    `$1${REDACTED_VALUE}`
  );
  text = text.replace(
    /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s/@]+)(@)/giu,
    `$1${REDACTED_VALUE}$3`
  );

  return text;
}

export function redactCommandArgs(args = []) {
  const values = Array.isArray(args) ? args : [args];
  const redacted = [];
  let redactNext = false;

  for (const value of values) {
    const text = stringValue(value);
    if (redactNext) {
      redacted.push(REDACTED_VALUE);
      redactNext = false;
      continue;
    }

    const assignment = text.match(/^([^=:]+)([=:])(.*)$/su);
    if (assignment && isSensitiveOptionName(assignment[1])) {
      redacted.push(`${assignment[1]}${assignment[2]}${REDACTED_VALUE}`);
      continue;
    }

    if (isSensitiveOptionName(text)) {
      redacted.push(text);
      redactNext = true;
      continue;
    }

    redacted.push(redactSensitiveText(text));
  }

  return redacted;
}

export function formatCommandLine(command, args = []) {
  const safeCommand = quoteCommandPart(redactSensitiveText(command));
  const safeArgs = redactCommandArgs(args).map(quoteCommandPart);
  return [safeCommand, ...safeArgs].join(" ");
}

export function sanitizeDiagnosticValue(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return redactSensitiveText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (Buffer.isBuffer(value)) return redactSensitiveText(value.toString("utf8"));
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return sanitizeDiagnosticValue(
      {
        name: value.name,
        message: value.message,
        code: value.code,
        stack: value.stack,
      },
      seen
    );
  }
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDiagnosticValue(item, seen));
  }

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (ENVIRONMENT_FIELD_PATTERN.test(key) || SENSITIVE_OPTION_PATTERN.test(key)) {
      result[key] = REDACTED_VALUE;
    } else if (key === "args" && Array.isArray(item)) {
      result[key] = redactCommandArgs(item);
    } else {
      result[key] = sanitizeDiagnosticValue(item, seen);
    }
  }
  return result;
}

function finiteOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeTimestamp(value) {
  if (value) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

function resolveOsCode(error, explicitOsCode) {
  if (explicitOsCode !== undefined && explicitOsCode !== null) {
    return String(explicitOsCode);
  }
  const errorCode = error?.osCode ?? error?.code;
  return typeof errorCode === "string" ? errorCode : null;
}

function resolveExitCode(error, explicitExitCode) {
  if (explicitExitCode !== undefined && explicitExitCode !== null) {
    return finiteOrNull(explicitExitCode);
  }
  if (error?.exitCode !== undefined && error?.exitCode !== null) {
    return finiteOrNull(error.exitCode);
  }
  return typeof error?.code === "number" ? error.code : null;
}

export function createDiagnostic(options = {}) {
  const error = options.error;
  const inherited = error?.diagnostic && typeof error.diagnostic === "object"
    ? error.diagnostic
    : {};
  const code = options.code || inherited.code || "STARTUP_FAILED";
  const stdout =
    options.stdoutTail ?? options.stdout ?? inherited.stdoutTail ?? error?.stdout ?? "";
  const stderr =
    options.stderrTail ?? options.stderr ?? inherited.stderrTail ?? error?.stderr ?? "";
  const reason =
    options.reason || inherited.reason || error?.reason || error?.message || String(error || code);
  const commandLine = options.commandLine || inherited.commandLine ||
    (options.command ? formatCommandLine(options.command, options.args) : null);

  return sanitizeDiagnosticValue({
    id: options.id || inherited.id || crypto.randomUUID(),
    code,
    stage: options.stage || inherited.stage || "startup",
    reason,
    commandLine: commandLine ? redactSensitiveText(commandLine) : null,
    cwd: options.cwd ?? inherited.cwd ?? null,
    osCode: resolveOsCode(error, options.osCode ?? inherited.osCode),
    exitCode: resolveExitCode(error, options.exitCode ?? inherited.exitCode),
    signal: options.signal ?? inherited.signal ?? error?.signal ?? null,
    timedOut: Boolean(options.timedOut ?? inherited.timedOut ?? error?.timedOut),
    durationMs: finiteOrNull(options.durationMs ?? inherited.durationMs),
    stdoutTail: truncateUtf8Tail(stdout),
    stderrTail: truncateUtf8Tail(stderr),
    attempts: options.attempts ?? inherited.attempts ?? [],
    timestamp: normalizeTimestamp(options.timestamp ?? inherited.timestamp),
    logPath: options.logPath ?? inherited.logPath ?? null,
  });
}

export function getRecoveryHint(code, fallback) {
  return fallback || DEFAULT_RECOVERY_HINTS[code] || DEFAULT_RECOVERY_HINTS.STARTUP_FAILED;
}

export function normalizeStartupFailure(error, options = {}) {
  const source = error && typeof error === "object" ? error : {};
  const code =
    options.code || source.diagnostic?.code || source.startupCode || "STARTUP_FAILED";
  const diagnostic = createDiagnostic({
    ...source.diagnostic,
    ...options.diagnostic,
    code,
    stage: options.stage || options.diagnostic?.stage || source.diagnostic?.stage,
    reason: options.reason || source.diagnostic?.reason || source.message || stringValue(error),
    error: source,
    command: options.command,
    args: options.args,
    commandLine: options.commandLine,
    cwd: options.cwd,
    osCode: options.osCode,
    exitCode: options.exitCode,
    signal: options.signal,
    timedOut: options.timedOut,
    durationMs: options.durationMs,
    stdout: options.stdout,
    stderr: options.stderr,
    attempts: options.attempts,
    logPath: options.logPath,
  });
  const message =
    options.userMessage || source.userMessage || source.error || source.message || "启动失败。";
  const recoveryHint = getRecoveryHint(
    code,
    options.recoveryHint || source.recoveryHint
  );

  return {
    success: false,
    code,
    error: redactSensitiveText(message),
    recoveryHint: redactSensitiveText(recoveryHint),
    diagnostic,
  };
}

export const toStartupFailure = normalizeStartupFailure;

export class StartupProcessError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "StartupProcessError";
    this.diagnostic = createDiagnostic({
      ...options.diagnostic,
      error: options.cause,
    });
    this.code = this.diagnostic.code;
    this.startupCode = this.diagnostic.code;
    this.userMessage = options.userMessage || message;
    this.recoveryHint = getRecoveryHint(this.code, options.recoveryHint);
    this.osCode = this.diagnostic.osCode;
    this.exitCode = this.diagnostic.exitCode;
    this.signal = this.diagnostic.signal;
    this.timedOut = this.diagnostic.timedOut;
    this.stdout = this.diagnostic.stdoutTail;
    this.stderr = this.diagnostic.stderrTail;
  }

  toFailure(overrides = {}) {
    return normalizeStartupFailure(this, overrides);
  }
}

export function formatStartupLogEntry(entry, options = {}) {
  const value = typeof entry === "string" ? { message: entry } : { ...(entry || {}) };
  const timestamp = normalizeTimestamp(value.timestamp || options.timestamp);
  const level = stringValue(value.level || options.level || "info").toLowerCase();
  const message = stringValue(value.message || options.message);
  delete value.timestamp;
  delete value.level;
  delete value.message;

  return `${JSON.stringify(sanitizeDiagnosticValue({
    timestamp,
    level,
    message,
    ...value,
  }))}\n`;
}

function isMissingFileError(error) {
  return error?.code === "ENOENT";
}

async function ignoreMissing(operation) {
  try {
    return await operation();
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    return undefined;
  }
}

export function createStartupLogger(options = {}) {
  const logPath = options.logPath;
  if (!logPath || typeof logPath !== "string") {
    throw new TypeError("createStartupLogger requires a logPath string.");
  }

  const fsImpl = options.fsImpl || fs;
  const maxBytes = Math.max(1, Number(options.maxBytes) || STARTUP_LOG_MAX_BYTES);
  const backupCount = Math.max(
    0,
    Number.isFinite(options.backupCount)
      ? Math.floor(options.backupCount)
      : STARTUP_LOG_BACKUP_COUNT
  );
  const consoleImpl = options.consoleImpl || console;
  let queue = Promise.resolve();

  const reportWriteFailure = (error) => {
    try {
      consoleImpl.error?.(`[startup-log] ${error?.message || error}`);
    } catch {
      // Logging must never interrupt application startup.
    }
  };

  const rotate = async () => {
    if (backupCount === 0) {
      await ignoreMissing(() => fsImpl.unlink(logPath));
      return;
    }

    await ignoreMissing(() => fsImpl.unlink(`${logPath}.${backupCount}`));
    for (let index = backupCount - 1; index >= 1; index -= 1) {
      await ignoreMissing(() =>
        fsImpl.rename(`${logPath}.${index}`, `${logPath}.${index + 1}`)
      );
    }
    await ignoreMissing(() => fsImpl.rename(logPath, `${logPath}.1`));
  };

  const fitLine = (line) => {
    const buffer = Buffer.from(line, "utf8");
    if (buffer.length <= maxBytes) return line;

    const marker = formatStartupLogEntry({
      level: "warning",
      message: "Startup log entry exceeded the file size limit and was truncated.",
    });
    if (Buffer.byteLength(marker, "utf8") <= maxBytes) return marker;
    return truncateUtf8Tail(marker, maxBytes);
  };

  const append = async (entry) => {
    await fsImpl.mkdir(path.dirname(logPath), { recursive: true });
    const timestamp = typeof options.now === "function" ? options.now() : undefined;
    const line = fitLine(formatStartupLogEntry(entry, { timestamp }));
    const lineBytes = Buffer.byteLength(line, "utf8");
    const stat = await ignoreMissing(() => fsImpl.stat(logPath));
    if (stat && stat.size + lineBytes > maxBytes) await rotate();
    await fsImpl.appendFile(logPath, line, "utf8");
  };

  const write = (entry) => {
    const task = queue.then(() => append(entry));
    queue = task.catch(reportWriteFailure);
    return queue;
  };

  const withLevel = (level) => (message, data = {}) =>
    write({ level, message, ...data });

  return Object.freeze({
    logPath,
    write,
    debug: withLevel("debug"),
    info: withLevel("info"),
    warning: withLevel("warning"),
    error: withLevel("error"),
    flush: () => queue,
  });
}
