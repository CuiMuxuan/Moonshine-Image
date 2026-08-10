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
  DEFAULT_PYTHON_VERSION,
  buildEnvironmentSpec,
} from "../../src-electron/runtime/environment-spec.js";

test("default Python installer URL matches the managed environment version", () => {
  assert.match(
    DEFAULT_PYTHON_INSTALLER_URL,
    new RegExp(`/${DEFAULT_PYTHON_VERSION}/python-${DEFAULT_PYTHON_VERSION}-amd64\\.exe$`),
  );
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
      return { success: true, code: 0, stdout: "ok", stderr: "" };
    },
    probe: async () => ({ success: true, python: {}, torch: {}, cuda: {}, backend: {}, ffmpeg: {} }),
    ...overrides,
  });
  return { manager, commands };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function offlineFixture(t, { variant = "cpu", appVersion = "1.3.0" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moonshine-offline-payload-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const payloadRoot = path.join(root, "offline-payload");
  const files = {
    "runtime/venv/Scripts/python.exe": "python 3.12.11",
    "runtime/requirements-lock.txt": "torch==2.11.0\n",
    "ffmpeg/ffmpeg.exe": "ffmpeg 8.0",
    "models/example.bin": "weights stay beside the payload",
  };
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
    ffmpegHash: sha256(files["ffmpeg/ffmpeg.exe"]),
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
  return { root, payloadRoot, manifest, files };
}

function makeOfflineBootstrap(data, overrides = {}) {
  const probeCalls = [];
  const manager = new EnvironmentBootstrap({
    rootDir: data.root,
    appVersion: "1.3.0",
    platform: "win32",
    arch: "x64",
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
    "python-discovery",
    "python-ready",
    "create-venv",
    "upgrade-pip",
    "install-requirements",
    "copy-ffmpeg",
    "health-probe",
    "complete",
  ]);
  assert.equal(progress.at(-1).percent, 100);
  assert.equal(progress.at(-1).status, "complete");
});

test("bootstrap uses source overrides and leaves the previous active environment intact after failure", async (t) => {
  const data = await fixture(t);
  const first = makeBootstrap(data);
  const installed = await first.manager.bootstrap({ accelerator: "cpu" });
  assert.equal(installed.success, true);
  const activePath = path.join(data.root, "environments", "active.json");
  const originalPointer = await fs.readFile(activePath, "utf8");

  const failed = makeBootstrap(data, {
    commandRunner: async (_command, args) => {
      if (args[0] === "-m" && args[1] === "pip" && args[2] === "install" && args.includes("-r")) {
        return { success: false, code: 1, stderr: "mirror unavailable" };
      }
      return { success: true, code: 0, stdout: "ok" };
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
  assert.ok(result.state.error.message.includes("install-requirements"));
  assert.equal((await fs.readdir(path.join(data.root, "environments", ".staging"))).length, 0);
  assert.equal(progress.at(-1).status, "failed");
  assert.equal(progress.at(-1).phase, "install-requirements");
  assert.notEqual(progress.at(-1).percent, 100);
});

test("offline payload import verifies files, reuses a prebuilt venv, and never copies models", async (t) => {
  const data = await offlineFixture(t);
  const { manager, probeCalls } = makeOfflineBootstrap(data);
  const result = await manager.importOfflinePayload({ offlinePayloadRoot: data.payloadRoot, accelerator: "cpu" });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.offline, true);
  assert.equal(result.created, true);
  assert.equal(result.spec.specHash, data.manifest.specHash);
  assert.equal(probeCalls.length, 1);
  assert.match(probeCalls[0].pythonExecutable, /venv\\Scripts\\python\.exe$/);
  const pointer = JSON.parse(await fs.readFile(path.join(data.root, "environments", "active.json"), "utf8"));
  assert.equal(pointer.source, "offline-payload");
  assert.equal(await fs.readFile(path.join(data.root, pointer.path, "venv", "Scripts", "python.exe"), "utf8"), "python 3.12.11");
  assert.equal(await fs.readFile(path.join(data.root, pointer.path, "ffmpeg", "ffmpeg.exe"), "utf8"), "ffmpeg 8.0");
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

test("offline payload import rejects variant, traversal, missing runtime, and missing FFmpeg", async (t) => {
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

  const missingFfmpeg = await offlineFixture(t);
  const ffmpegManifest = { ...missingFfmpeg.manifest, files: missingFfmpeg.manifest.files.filter(({ path: value }) => !value.startsWith("ffmpeg/")) };
  const ffmpegResult = await makeOfflineBootstrap(missingFfmpeg).manager.importOfflinePayload({
    payloadRoot: missingFfmpeg.payloadRoot,
    manifest: ffmpegManifest,
    accelerator: "cpu",
  });
  assert.equal(ffmpegResult.code, "ENVIRONMENT_PAYLOAD_FFMPEG_MISSING");
});
