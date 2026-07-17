import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDiagnostic,
  createStartupLogger,
  formatCommandLine,
  normalizeStartupFailure,
  REDACTED_VALUE,
  sanitizeDiagnosticValue,
  STARTUP_OUTPUT_TAIL_BYTES,
  truncateUtf8Tail,
} from "../../src-electron/startup-diagnostics.js";

test("command formatting and structured values redact sensitive arguments", () => {
  const commandLine = formatCommandLine("python", [
    "worker.py",
    "--password",
    "open-sesame",
    "--token=token-value",
    "api-key:key-value",
    "--key",
    "raw-key-value",
    '--license-key="quoted key value"',
    "https://alice:url-password@example.invalid/path",
  ]);

  assert.doesNotMatch(
    commandLine,
    /open-sesame|token-value|key-value|raw-key-value|quoted key value|url-password/u
  );
  assert.match(commandLine, /worker\.py/u);
  assert.ok(commandLine.split(REDACTED_VALUE).length >= 6);

  const sanitized = sanitizeDiagnosticValue({
    env: { PATH: "should-not-be-recorded" },
    clientSecret: "secret-value",
    args: ["--token", "another-token", "visible"],
    message: 'run --license-key "quoted raw key" password=inline-password',
  });
  assert.equal(sanitized.env, REDACTED_VALUE);
  assert.equal(sanitized.clientSecret, REDACTED_VALUE);
  assert.deepEqual(sanitized.args, ["--token", REDACTED_VALUE, "visible"]);
  assert.doesNotMatch(sanitized.message, /quoted raw key|inline-password/u);
});

test("UTF-8 output tails stay within the 32 KiB byte limit", () => {
  const input = `discard-me-${"界".repeat(20_000)}`;
  const tail = truncateUtf8Tail(input);

  assert.ok(Buffer.byteLength(tail, "utf8") <= STARTUP_OUTPUT_TAIL_BYTES);
  assert.doesNotMatch(tail, /\uFFFD/u);
  assert.ok(tail.endsWith("界".repeat(100)));
});

test("diagnostics preserve process metadata and cap output tails", () => {
  const cause = Object.assign(new Error("executable is unavailable"), {
    code: "ENOENT",
  });
  const diagnostic = createDiagnostic({
    code: "PYTHON_PROBE_FAILED",
    stage: "python-detection",
    command: "python",
    args: ["--token", "do-not-log", "--version"],
    cwd: "C:/project",
    error: cause,
    exitCode: 7,
    signal: "SIGTERM",
    timedOut: true,
    durationMs: 125.5,
    stdout: "o".repeat(STARTUP_OUTPUT_TAIL_BYTES + 100),
    stderr: "e".repeat(STARTUP_OUTPUT_TAIL_BYTES + 200),
    attempts: [{ command: "python", status: "failed" }],
    logPath: "C:/logs/startup.log",
    timestamp: "2026-01-02T03:04:05.000Z",
  });

  assert.equal(diagnostic.code, "PYTHON_PROBE_FAILED");
  assert.equal(diagnostic.stage, "python-detection");
  assert.equal(diagnostic.osCode, "ENOENT");
  assert.equal(diagnostic.exitCode, 7);
  assert.equal(diagnostic.signal, "SIGTERM");
  assert.equal(diagnostic.timedOut, true);
  assert.equal(diagnostic.durationMs, 125.5);
  assert.equal(diagnostic.timestamp, "2026-01-02T03:04:05.000Z");
  assert.equal(Buffer.byteLength(diagnostic.stdoutTail), STARTUP_OUTPUT_TAIL_BYTES);
  assert.equal(Buffer.byteLength(diagnostic.stderrTail), STARTUP_OUTPUT_TAIL_BYTES);
  assert.doesNotMatch(diagnostic.commandLine, /do-not-log/u);
});

test("startup failures use the additive compatibility contract", () => {
  const cause = Object.assign(new Error("spawn failed"), { code: "EACCES" });
  const failure = normalizeStartupFailure(cause, {
    code: "BACKEND_SPAWN_FAILED",
    stage: "backend-start",
    userMessage: "后端无法启动。",
    recoveryHint: "请检查执行权限。",
    command: "python",
    args: ["server.py"],
  });

  assert.equal(failure.success, false);
  assert.equal(failure.code, "BACKEND_SPAWN_FAILED");
  assert.equal(failure.error, "后端无法启动。");
  assert.equal(failure.recoveryHint, "请检查执行权限。");
  assert.equal(failure.diagnostic.code, failure.code);
  assert.equal(failure.diagnostic.osCode, "EACCES");
  assert.equal(failure.diagnostic.stage, "backend-start");
});

test("startup logger rotates two backups and redacts log data", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "moonshine-startup-log-"));
  const logPath = path.join(directory, "startup.log");
  const logger = createStartupLogger({
    logPath,
    maxBytes: 340,
    backupCount: 2,
  });

  try {
    for (let index = 0; index < 5; index += 1) {
      await logger.info("runtime preparation", {
        index,
        token: `token-${index}`,
        commandLine: `installer --password password-${index}`,
        detail: "x".repeat(90),
      });
    }
    await logger.flush();

    const paths = [logPath, `${logPath}.1`, `${logPath}.2`];
    const contents = await Promise.all(paths.map((filePath) => fs.readFile(filePath, "utf8")));
    const stats = await Promise.all(paths.map((filePath) => fs.stat(filePath)));
    const combined = contents.join("\n");

    assert.ok(stats.every((stat) => stat.size <= 340));
    assert.doesNotMatch(combined, /token-[0-9]|password-[0-9]/u);
    assert.match(combined, /\[REDACTED\]/u);
    await assert.rejects(fs.stat(`${logPath}.3`), { code: "ENOENT" });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("startup logger preserves multiline bundled runtime relocation stderr", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "moonshine-relocation-log-"));
  const logPath = path.join(directory, "startup.log");
  const logger = createStartupLogger({ logPath });
  const stderr =
    "Traceback (most recent call last):\nPermissionError: [Errno 13] Permission denied: torch/_C.pyd";

  try {
    await logger.warning(stderr, {
      code: "BUNDLED_RUNTIME_RELOCATION_STDERR",
      stage: "bundled-runtime-relocation",
      stream: "stderr",
      source: "conda-unpack",
    });
    await logger.flush();

    const [entry] = (await fs.readFile(logPath, "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line));

    assert.equal(entry.level, "warning");
    assert.equal(entry.stage, "bundled-runtime-relocation");
    assert.equal(entry.stream, "stderr");
    assert.equal(entry.source, "conda-unpack");
    assert.match(entry.message, /Traceback/u);
    assert.match(entry.message, /\n/u);
    assert.match(entry.message, /PermissionError/u);
    assert.match(entry.message, /torch\/_C\.pyd/u);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("startup logger falls back to the console without rejecting", async () => {
  const messages = [];
  const failure = Object.assign(new Error("disk is read-only"), { code: "EACCES" });
  const logger = createStartupLogger({
    logPath: "C:/unavailable/startup.log",
    fsImpl: {
      mkdir: async () => {
        throw failure;
      },
    },
    consoleImpl: {
      error: (message) => messages.push(message),
    },
  });

  await assert.doesNotReject(logger.error("cannot write"));
  assert.equal(messages.length, 1);
  assert.match(messages[0], /disk is read-only/u);
});
