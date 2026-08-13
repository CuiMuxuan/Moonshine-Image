import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BOOTSTRAP_STATUS,
  DEFAULT_PYTHON_INSTALLER_URL,
  EnvironmentBootstrap,
} from "../../src-electron/runtime/environment-bootstrap.js";
import {
  BUNDLED_FFMPEG_SPEC_HASH,
  DEFAULT_PYTHON_VERSION,
  buildEnvironmentSpec,
} from "../../src-electron/runtime/environment-spec.js";

test("default Python installer URL matches the managed environment version", () => {
  assert.match(
    DEFAULT_PYTHON_INSTALLER_URL,
    new RegExp(`/${DEFAULT_PYTHON_VERSION}/python-${DEFAULT_PYTHON_VERSION}-amd64\\.exe$`),
  );
});

test("Python discovery rejects 3.8 and 3.10 candidates instead of treating any successful command as 3.12", async (t) => {
  const data = await fixture(t);
  const { manager } = makeBootstrap(data, {
    pythonExecutable: ["python", "python3"],
    commandRunner: async (command, args) => ({
      success: true,
      code: 0,
      stdout: args[0] === "--version" ? `Python ${command === "python" ? "3.10.14" : "3.8.20"}` : "ok",
      stderr: "",
    }),
  });
  await assert.rejects(
    manager._discoverPython(),
    (error) => error.code === "ENVIRONMENT_PYTHON_NOT_FOUND"
      && error.details.expectedVersion === "3.12.x"
      && error.details.discoveries.every((entry) => entry.compatible === false),
  );
});

test("Python discovery verifies an installer result before accepting it", async (t) => {
  const data = await fixture(t);
  const installedPython = path.join(data.root, "Python312", "python.exe");
  const { manager } = makeBootstrap(data, {
    pythonExecutable: "python",
    pythonInstaller: async () => ({ pythonPath: installedPython }),
    commandRunner: async (command, args) => ({
      success: true,
      code: 0,
      stdout: args[0] === "--version" ? `Python ${command === installedPython ? "3.12.9" : "3.10.14"}` : "ok",
      stderr: "",
    }),
  });
  assert.equal(await manager._discoverPython(), installedPython);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moonshine-environment-bootstrap-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const requirementsPath = path.join(root, "requirements-lock.txt");
  const ffmpegSourcePath = path.join(root, "ffmpeg.exe");
  await fs.writeFile(requirementsPath, "torch==2.11.0\n");
  await fs.writeFile(ffmpegSourcePath, "fake ffmpeg");
  return { root, requirementsPath, ffmpegSourcePath };
}

function makeBootstrap(fixtureData, overrides = {}) {
  const commands = [];
  const manager = new EnvironmentBootstrap({
    rootDir: fixtureData.root,
    appVersion: "1.3.0",
    requirementsPath: fixtureData.requirementsPath,
    ffmpegSourcePath: fixtureData.ffmpegSourcePath,
    detector: async ({ preference }) => ({
      preference,
      selectedAccelerator: preference === "cu130" ? "cu130" : "cpu",
      reason: "test",
      nvidia: { available: false, compatible: false },
    }),
    commandRunner: async (command, args) => {
      commands.push({ command, args });
      return { success: true, code: 0, stdout: args[0] === "--version" ? "Python 3.12.10" : "ok", stderr: "" };
    },
    probe: async () => ({ success: true, python: {}, torch: {}, cuda: {}, backend: {}, ffmpeg: {} }),
    ...overrides,
  });
  return { manager, commands };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function offlineFixture(t, { variant = "cpu", appVersion = "1.3.0", legacyFfmpeg = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moonshine-offline-payload-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const payloadRoot = path.join(root, "offline-payload");
  const files = {
    "runtime/venv/Scripts/python.exe": "python 3.12.11",
    "runtime/requirements-lock.txt": "torch==2.11.0\n",
    "models/example.bin": "weights stay beside the payload",
  };
  if (legacyFfmpeg) files["ffmpeg/ffmpeg.exe"] = "legacy ffmpeg 8.0";
  for (const [relative, value] of Object.entries(files)) {
    const target = path.join(payloadRoot, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, value);
  }
  const manifestFiles = await Promise.all(Object.entries(files).map(async ([relative, value]) => ({
    path: relative,
    size: Buffer.byteLength(value),
    sha256: sha256(value),
  })));
  const environmentSpec = buildEnvironmentSpec({
    appVersion,
    pythonVersion: "3.12.11",
    accelerator: variant,
    requirementsLockHash: sha256(files["runtime/requirements-lock.txt"]),
    ffmpegHash: BUNDLED_FFMPEG_SPEC_HASH,
  });
  const manifest = {
    schema: 1,
    appVersion,
    variant,
    specHash: environmentSpec.specHash,
    environmentSpec,
    files: manifestFiles,
  };
  await fs.writeFile(path.join(payloadRoot, "payload-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const bundledFfmpegPath = path.join(root, "app-resources", "ffmpeg", "ffmpeg.exe");
  await fs.mkdir(path.dirname(bundledFfmpegPath), { recursive: true });
  await fs.writeFile(bundledFfmpegPath, "bundled ffmpeg 8.0");
  return { root, payloadRoot, manifest, files, bundledFfmpegPath };
}

function makeOfflineBootstrap(data, overrides = {}) {
  const probeCalls = [];
  const manager = new EnvironmentBootstrap({
    rootDir: data.root,
    appVersion: "1.3.0",
    platform: "win32",
    arch: "x64",
    ffmpegSourcePath: data.bundledFfmpegPath,
    probe: async (options) => {
      probeCalls.push(options);
      return { success: true, python: {}, torch: {}, cuda: {}, backend: {}, ffmpeg: {} };
    },
    ...overrides,
  });
  return { manager, probeCalls };
}

test("bootstrap stages Python/venv/pip and atomically activates a verified environment", async (t) => {
  const data = await fixture(t);
  const { manager, commands } = makeBootstrap(data);
  const progress = [];
  const result = await manager.bootstrap({
    accelerator: "cpu",
    onProgress: (value) => progress.push(value),
  });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.created, true);
  assert.equal(result.state.status, BOOTSTRAP_STATUS.READY);
  assert.ok(result.spec.specHash);
  assert.deepEqual(commands[0].args, ["--version"]);
  assert.ok(commands.some(({ args }) => args[0] === "-m" && args[1] === "venv"));
  assert.ok(commands.some(({ args }) => args[0] === "-m" && args[1] === "pip" && args.includes("--index-url")));
  const pointer = JSON.parse(await fs.readFile(path.join(data.root, "environments", "active.json"), "utf8"));
  assert.equal(pointer.specHash, result.spec.specHash);
  assert.equal(await fs.readFile(path.join(data.root, pointer.path, "environment-spec.json"), "utf8"), `${JSON.stringify(result.spec, null, 2)}\n`);
  assert.equal(await fs.stat(result.state.stagingPath || path.join(data.root, "does-not-exist")).catch((error) => error.code), "ENOENT");
  assert.deepEqual(progress.map((value) => value.phase), [
    "preparing",
    "detect-accelerator",
    "resolve-environment",
    "environment-path",
    "python-discovery",
    "python-ready",
    "create-venv",
    "upgrade-pip",
    "pip-ready",
    "install-requirements",
    "dependencies-ready",
    "resolve-ffmpeg",
    "health-probe",
    "complete",
  ]);
  assert.equal(progress.at(-1).percent, 100);
  assert.equal(progress.at(-1).status, "complete");
  assert.equal(pointer.ffmpegSource, "bundled");
  assert.equal(pointer.ffmpegRelative, undefined);
  assert.equal(pointer.pythonExecutableRelative, "venv/Scripts/python.exe");
  assert.equal(pointer.pythonExecutableRelative.includes(".staging"), false);
  await assert.rejects(fs.access(path.join(data.root, pointer.path, "ffmpeg", "ffmpeg.exe")));
});

test("bootstrap rejects unsafe pointer paths and migrates staging-era Python pointers", async (t) => {
  const data = await fixture(t);
  const first = makeBootstrap(data);
  const installed = await first.manager.bootstrap({ accelerator: "cpu" });
  const pointerPath = path.join(data.root, "environments", "active.json");
  const pointer = JSON.parse(await fs.readFile(pointerPath, "utf8"));
  pointer.pythonExecutableRelative = "../../.staging/old/venv/Scripts/python.exe";
  await fs.writeFile(pointerPath, `${JSON.stringify(pointer)}\n`);

  const reused = await makeBootstrap(data).manager.bootstrap({ accelerator: "cpu" });
  assert.equal(reused.reused, true);
  const migrated = JSON.parse(await fs.readFile(pointerPath, "utf8"));
  assert.equal(migrated.pythonExecutableRelative, "venv/Scripts/python.exe");

  pointer.path = "../outside";
  await fs.writeFile(pointerPath, `${JSON.stringify(pointer)}\n`);
  assert.equal(await makeBootstrap(data).manager.getActive(), null);
  assert.ok(installed.activePath);
});

test("force repair still reuses an environment that passes the full health probe", async (t) => {
  const data = await fixture(t);
  const installed = await makeBootstrap(data).manager.bootstrap({ accelerator: "cpu" });
  assert.equal(installed.success, true);

  const { manager, commands } = makeBootstrap(data);
  const result = await manager.bootstrap({ accelerator: "cpu", force: true });

  assert.equal(result.success, true);
  assert.equal(result.reused, true);
  assert.equal(result.created, false);
  assert.equal(commands.some(({ args }) => args[0] === "-m" && args[1] === "venv"), false);
  assert.equal(commands.some(({ args }) => args.includes("-r")), false);
});

test("repair seeds the active environment and skips valid Python, pip, and locked dependencies", async (t) => {
  const data = await fixture(t);
  const installed = await makeBootstrap(data).manager.bootstrap({ accelerator: "cpu" });
  const activePython = path.join(installed.activePath, "venv", "Scripts", "python.exe");
  await fs.mkdir(path.dirname(activePython), { recursive: true });
  await fs.writeFile(activePython, "python test executable");

  let probeCount = 0;
  const commands = [];
  const { manager } = makeBootstrap(data, {
    probe: async () => ({ success: ++probeCount > 1 }),
    commandRunner: async (command, args) => {
      commands.push({ command, args });
      if (args[0] === "--version") return { success: true, code: 0, stdout: "Python 3.12.10" };
      if (args.includes("list")) return { success: true, code: 0, stdout: JSON.stringify([{ name: "torch", version: "2.11.0" }]) };
      return { success: true, code: 0, stdout: "ok" };
    },
  });
  const progress = [];
  const result = await manager.bootstrap({
    accelerator: "cpu",
    force: true,
    onProgress: (value) => progress.push(value),
  });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(commands.some(({ args }) => args[0] === "-m" && args[1] === "venv"), false);
  assert.equal(commands.some(({ args }) => args.includes("-r")), false);
  assert.ok(progress.some((entry) => entry.phase === "pip-ready" && /跳过更新/u.test(entry.message)));
  assert.ok(progress.some((entry) => entry.phase === "dependencies-ready" && /跳过安装/u.test(entry.message)));
});

test("dependency installation streams subprocess output as log-only progress", async (t) => {
  const data = await fixture(t);
  const progress = [];
  const { manager } = makeBootstrap(data, {
    commandRunner: async (_command, args, options) => {
      if (args.includes("-r")) {
        options.onStdout?.("Collecting torch\n");
        options.onStderr?.("Using cached wheel\n");
      }
      return { success: true, code: 0, stdout: args[0] === "--version" ? "Python 3.12.10" : "ok", stderr: "" };
    },
  });
  const result = await manager.bootstrap({
    accelerator: "cpu",
    onProgress: (value) => progress.push(value),
  });

  assert.equal(result.success, true);
  assert.ok(progress.some((entry) => entry.logOnly && /Collecting torch/u.test(entry.message)));
  assert.ok(progress.some((entry) => entry.logOnly && entry.terminalType === "warning" && /cached wheel/u.test(entry.message)));
});

test("bootstrap cancellation removes staging and preserves the active pointer", async (t) => {
  const data = await fixture(t);
  const first = makeBootstrap(data);
  const installed = await first.manager.bootstrap({ accelerator: "cpu" });
  assert.equal(installed.success, true);
  const activePath = path.join(data.root, "environments", "active.json");
  const originalPointer = await fs.readFile(activePath, "utf8");
  const controller = new AbortController();
  let probeCount = 0;
  const cancelled = makeBootstrap(data, {
    probe: async () => ({ success: ++probeCount > 1 }),
    commandRunner: async (_command, args, options) => {
      if (args[0] === "-m" && args[1] === "venv") controller.abort(new Error("user cancelled"));
      if (options.signal?.aborted) return { success: false, code: 1, stderr: "aborted" };
      return { success: true, code: 0, stdout: args[0] === "--version" ? "Python 3.12.10" : "ok" };
    },
  });
  const result = await cancelled.manager.bootstrap({
    accelerator: "cpu",
    force: true,
    signal: controller.signal,
  });

  assert.equal(result.success, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.code, "ENVIRONMENT_PREPARATION_CANCELLED");
  assert.equal(result.state.status, BOOTSTRAP_STATUS.CANCELLED);
  assert.equal(await fs.readFile(activePath, "utf8"), originalPointer);
  assert.equal((await fs.readdir(path.join(data.root, "environments", ".staging"))).length, 0);
});

test("stale staging cleanup removes abandoned operation directories", async (t) => {
  const data = await fixture(t);
  const manager = makeBootstrap(data).manager;
  const stalePath = path.join(data.root, "environments", ".staging", "abandoned");
  await fs.mkdir(stalePath, { recursive: true });
  await fs.writeFile(path.join(stalePath, ".operation.json"), "{}\n");

  const result = await manager.cleanupStaleStaging();
  assert.equal(result.count, 1);
  await assert.rejects(fs.access(stalePath));
});

test("bootstrap activates a degraded environment when only bundled FFmpeg fails", async (t) => {
  const data = await fixture(t);
  const { manager } = makeBootstrap(data, {
    probe: async () => ({
      success: true,
      degraded: true,
      python: { ok: true },
      torch: { ok: true },
      cuda: { ok: true },
      backend: { ok: true },
      ffmpeg: { ok: false, path: data.ffmpegSourcePath },
      warnings: ["FFmpeg: required DLL was not found"],
      capabilities: { core: true, image: true, video: false, ffmpeg: false },
    }),
  });

  const result = await manager.bootstrap({ accelerator: "cpu" });
  assert.equal(result.success, true);
  assert.equal(result.degraded, true);
  assert.equal(result.state.status, BOOTSTRAP_STATUS.DEGRADED);
  assert.equal(result.health.capabilities.video, false);
});

test("bootstrap keeps the core environment usable when bundled FFmpeg is physically missing", async (t) => {
  const data = await fixture(t);
  await fs.rm(data.ffmpegSourcePath);
  const { manager } = makeBootstrap(data);

  const result = await manager.bootstrap({ accelerator: "cpu" });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.degraded, true);
  assert.equal(result.state.status, BOOTSTRAP_STATUS.DEGRADED);
  assert.equal(result.health.ffmpeg.ok, false);
  assert.equal(result.health.ffmpeg.resourceError.code, "ENVIRONMENT_FFMPEG_UNAVAILABLE");
  assert.equal(result.health.capabilities.core, true);
  assert.equal(result.health.capabilities.video, false);
});

test("bootstrap degrades video capability when bundled FFmpeg integrity does not match", async (t) => {
  const data = await fixture(t);
  const { manager } = makeBootstrap(data, { ffmpegHash: sha256("expected ffmpeg") });

  const result = await manager.bootstrap({ accelerator: "cpu" });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.degraded, true);
  assert.equal(result.health.ffmpeg.resourceError.code, "ENVIRONMENT_HASH_MISMATCH");
  assert.equal(result.health.capabilities.video, false);
});

test("bootstrap uses source overrides and leaves the previous active environment intact after failure", async (t) => {
  const data = await fixture(t);
  const first = makeBootstrap(data);
  const installed = await first.manager.bootstrap({ accelerator: "cpu" });
  assert.equal(installed.success, true);
  const activePath = path.join(data.root, "environments", "active.json");
  const originalPointer = await fs.readFile(activePath, "utf8");

  let probeCount = 0;
  const failed = makeBootstrap(data, {
    probe: async () => ({ success: ++probeCount > 1 }),
    commandRunner: async (_command, args) => {
      if (args[0] === "-m" && args[1] === "pip" && args[2] === "install" && args.includes("-r")) {
        return { success: false, code: 1, stderr: "mirror unavailable" };
      }
      return { success: true, code: 0, stdout: args[0] === "--version" ? "Python 3.12.10" : "ok" };
    },
  });
  const progress = [];
  const result = await failed.manager.bootstrap({
    accelerator: "cpu",
    force: true,
    sourceOverrides: { pipIndexUrl: "https://mirror.example/simple" },
    onProgress: (value) => progress.push(value),
  });

  assert.equal(result.success, false);
  assert.equal(result.state.status, BOOTSTRAP_STATUS.FAILED);
  assert.equal(await fs.readFile(activePath, "utf8"), originalPointer);
  assert.ok(result.state.steps.some((step) => step.name === "install-requirements" && step.status === "failed"));
  assert.match(result.state.error.message, /安装 Python 与 PyTorch 依赖/);
  assert.equal(result.state.error.details.phase, "install-requirements");
  assert.equal((await fs.readdir(path.join(data.root, "environments", ".staging"))).length, 0);
  assert.equal(progress.at(-1).status, "failed");
  assert.equal(progress.at(-1).phase, "install-requirements");
  assert.notEqual(progress.at(-1).percent, 100);
});

test("bootstrap captures thrown process diagnostics in a persistent failure receipt", async (t) => {
  const data = await fixture(t);
  const { manager } = makeBootstrap(data, {
    commandRunner: async (_command, args) => {
      if (args[0] === "-m" && args[1] === "pip" && args[2] === "install" && args.includes("-r")) {
        const error = new Error("pip subprocess rejected");
        error.exitCode = 23;
        error.stderr = "No matching distribution found for torch";
        throw error;
      }
      return { success: true, code: 0, stdout: args[0] === "--version" ? "Python 3.12.10" : "ok", stderr: "" };
    },
  });

  const result = await manager.bootstrap({ accelerator: "cpu", force: true });
  assert.equal(result.success, false);
  assert.equal(result.state.error.code, "ENVIRONMENT_COMMAND_FAILED");
  assert.match(result.state.error.message, /退出码 23/);
  assert.match(result.state.error.message, /No matching distribution/);

  const receiptPath = path.join(data.root, "environments", "last-failure.json");
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  assert.equal(receipt.phase, "install-requirements");
  assert.equal(receipt.error.code, "ENVIRONMENT_COMMAND_FAILED");
  assert.equal(receipt.error.details.result.code, 23);
  assert.match(receipt.error.details.result.stderr, /No matching distribution/);
  assert.equal((await fs.readdir(path.join(data.root, "environments", ".staging"))).length, 0);
});

test("offline payload import verifies files, reuses a prebuilt venv, and uses bundled FFmpeg in place", async (t) => {
  const data = await offlineFixture(t);
  const { manager, probeCalls } = makeOfflineBootstrap(data);
  const result = await manager.importOfflinePayload({ offlinePayloadRoot: data.payloadRoot, accelerator: "cpu" });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.offline, true);
  assert.equal(result.created, true);
  assert.equal(result.spec.specHash, data.manifest.specHash);
  assert.equal(probeCalls.length, 1);
  assert.match(probeCalls[0].pythonExecutable, /venv\\Scripts\\python\.exe$/);
  assert.equal(probeCalls[0].ffmpegPath, data.bundledFfmpegPath);
  const pointer = JSON.parse(await fs.readFile(path.join(data.root, "environments", "active.json"), "utf8"));
  assert.equal(pointer.source, "offline-payload");
  assert.equal(await fs.readFile(path.join(data.root, pointer.path, "venv", "Scripts", "python.exe"), "utf8"), "python 3.12.11");
  assert.equal(pointer.ffmpegSource, "bundled");
  assert.equal(await fs.stat(path.join(data.root, pointer.path, "ffmpeg")).catch((error) => error.code), "ENOENT");
  assert.equal(await fs.stat(path.join(data.root, pointer.path, "models")).catch((error) => error.code), "ENOENT");
  assert.equal(result.modelsPath, path.join(data.payloadRoot, "models"));
});

test("offline payload tampering fails before activation and preserves the old active pointer", async (t) => {
  const data = await offlineFixture(t);
  const first = makeOfflineBootstrap(data);
  const installed = await first.manager.importOfflinePayload({ payloadRoot: data.payloadRoot, accelerator: "cpu" });
  assert.equal(installed.success, true);
  const activePath = path.join(data.root, "environments", "active.json");
  const originalPointer = await fs.readFile(activePath, "utf8");
  await fs.writeFile(path.join(data.payloadRoot, "runtime", "venv", "Scripts", "python.exe"), "tampered");

  const result = await makeOfflineBootstrap(data).manager.importOfflinePayload({
    payloadRoot: data.payloadRoot,
    accelerator: "cpu",
    force: true,
  });
  assert.equal(result.success, false);
  assert.equal(result.code, "ENVIRONMENT_PAYLOAD_HASH_MISMATCH");
  assert.equal(result.state.status, BOOTSTRAP_STATUS.FAILED);
  assert.equal(await fs.readFile(activePath, "utf8"), originalPointer);
  assert.equal((await fs.readdir(path.join(data.root, "environments", ".staging"))).length, 0);
});

test("offline payload import rejects variant, traversal, and missing runtime without requiring FFmpeg payload files", async (t) => {
  const variant = await offlineFixture(t, { variant: "cu130" });
  const variantResult = await makeOfflineBootstrap(variant).manager.importOfflinePayload({
    payloadRoot: variant.payloadRoot,
    accelerator: "cpu",
  });
  assert.equal(variantResult.code, "ENVIRONMENT_PAYLOAD_VARIANT_MISMATCH");

  const traversal = await offlineFixture(t);
  const traversalManifest = { ...traversal.manifest, files: [{ ...traversal.manifest.files[0], path: "../escape.bin" }] };
  const traversalResult = await makeOfflineBootstrap(traversal).manager.importOfflinePayload({
    payloadRoot: traversal.payloadRoot,
    manifest: traversalManifest,
    accelerator: "cpu",
  });
  assert.equal(traversalResult.code, "ENVIRONMENT_PAYLOAD_PATH_INVALID");

  const missingRuntime = await offlineFixture(t);
  const runtimeManifest = { ...missingRuntime.manifest, files: missingRuntime.manifest.files.filter(({ path: value }) => !value.startsWith("runtime/")) };
  const runtimeResult = await makeOfflineBootstrap(missingRuntime).manager.importOfflinePayload({
    payloadRoot: missingRuntime.payloadRoot,
    manifest: runtimeManifest,
    accelerator: "cpu",
  });
  assert.equal(runtimeResult.code, "ENVIRONMENT_PAYLOAD_RUNTIME_MISSING");

  const withoutFfmpeg = await offlineFixture(t);
  const ffmpegResult = await makeOfflineBootstrap(withoutFfmpeg).manager.importOfflinePayload({
    payloadRoot: withoutFfmpeg.payloadRoot,
    accelerator: "cpu",
  });
  assert.equal(ffmpegResult.success, true, JSON.stringify(ffmpegResult));
});

test("legacy offline FFmpeg files are verified but never copied into the managed environment", async (t) => {
  const data = await offlineFixture(t, { legacyFfmpeg: true });
  const result = await makeOfflineBootstrap(data).manager.importOfflinePayload({
    payloadRoot: data.payloadRoot,
    accelerator: "cpu",
  });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(await fs.stat(path.join(result.activePath, "ffmpeg")).catch((error) => error.code), "ENOENT");

  await fs.writeFile(path.join(data.payloadRoot, "ffmpeg", "ffmpeg.exe"), "tampered legacy ffmpeg");
  const tampered = await makeOfflineBootstrap(data).manager.importOfflinePayload({
    payloadRoot: data.payloadRoot,
    accelerator: "cpu",
    force: true,
  });
  assert.equal(tampered.code, "ENVIRONMENT_PAYLOAD_HASH_MISMATCH");
});
