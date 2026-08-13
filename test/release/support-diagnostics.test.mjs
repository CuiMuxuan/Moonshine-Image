import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { createDefaultAppConfig } from "../../src/shared/appConfigSchema.js";

import {
  evaluateCudaCompatibility,
  inspectConfiguration,
  inspectEffectiveRuntime,
  inspectFailureReceipt,
  inspectHostEnvironment,
  inspectPythonInstallations,
  inspectPythonEnvironment,
  isCu130DriverCompatible,
  parseNvidiaSmi,
  parseRequirementsLock,
  probeConfiguredService,
  probeNetworkEndpoint,
} from "../../scripts/validation/support-diagnostics-lib.mjs";

async function temporaryRoot(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("host diagnostics parse NVIDIA devices and distinguish cu130 driver support", async () => {
  assert.deepEqual(parseNvidiaSmi("RTX 4090, 580.12\nRTX 3090, 570.86\n"), [
    { name: "RTX 4090", driverVersion: "580.12" },
    { name: "RTX 3090", driverVersion: "570.86" },
  ]);
  assert.equal(isCu130DriverCompatible("569.99"), false);
  assert.equal(isCu130DriverCompatible("570.01"), true);

  const runner = async (command) => command === "nvidia-smi"
    ? { code: 0, stdout: "RTX 4090, 580.12\n", stderr: "" }
    : { code: 0, stdout: "Cuda compilation tools, release 13.0, V13.0.1", stderr: "" };
  const result = await inspectHostEnvironment({ runner, platform: "win32", arch: "x64" });
  assert.equal(result.status, "pass");
  assert.equal(result.details.nvidia.available, true);
  assert.equal(result.details.nvidia.driverCompatible, true);
  assert.equal(result.details.cudaToolkit.version, "13.0");
  assert.equal(result.details.automaticAccelerator, "cu130");
});

test("Python inventory reports every discovered version and requires a usable 3.12 interpreter", async (t) => {
  const root = await temporaryRoot(t, "moonshine-validator-python-inventory-");
  const python310 = path.join(root, "Python310", "python.exe");
  const python312 = path.join(root, "conda", "moonshine", "python.exe");
  await fs.mkdir(path.dirname(python310), { recursive: true });
  await fs.mkdir(path.dirname(python312), { recursive: true });
  await fs.writeFile(python310, "placeholder");
  await fs.writeFile(python312, "placeholder");
  const structured = (executable, version) => `__MOONSHINE_PYTHON_INVENTORY__${JSON.stringify({
    version,
    versionInfo: version.split(".").map(Number),
    executable,
    prefix: path.dirname(executable),
    basePrefix: path.dirname(executable),
    architecture: "64bit",
    implementation: "CPython",
    isVirtualEnvironment: false,
  })}\n`;
  const runner = async (command, args) => {
    if (command === "py.exe") return { code: 0, stdout: ` -3.10-64 ${python310}\n`, stderr: "" };
    if (command === "where.exe") return { code: args[0] === "python.exe" ? 0 : 1, stdout: args[0] === "python.exe" ? `${python310}\n` : "", stderr: "" };
    if (command === "conda.exe") return { code: 0, stdout: JSON.stringify({ envs: [path.dirname(python312)] }), stderr: "" };
    if (command === python310) return { code: 0, stdout: structured(command, "3.10.14"), stderr: "" };
    if (command === python312) return { code: 0, stdout: structured(command, "3.12.10"), stderr: "" };
    return { code: 1, stdout: "", stderr: "not found" };
  };
  const result = await inspectPythonInstallations({
    runner,
    platform: "win32",
    env: { Path: "", LOCALAPPDATA: root, USERPROFILE: root },
    additionalCandidates: [python312],
  });
  assert.equal(result.status, "pass", JSON.stringify(result));
  assert.equal(result.details.usableCount, 2);
  assert.equal(result.details.compatibleCount, 1);
  assert.deepEqual(result.details.interpreters.map((entry) => entry.version).sort(), ["3.10.14", "3.12.10"]);
  assert.equal(result.details.interpreters.find((entry) => entry.version === "3.10.14").compatible, false);
  assert.ok(result.details.interpreters.find((entry) => entry.version === "3.12.10").sources.includes("effective-environment"));
});

test("configuration diagnostics accept defaults and reject invalid service settings", async (t) => {
  const userData = await temporaryRoot(t, "moonshine-validator-config-");
  const defaults = await inspectConfiguration({ userData });
  assert.equal(defaults.status, "pass");
  assert.equal(defaults.details.usingDefaults, true);
  assert.equal(defaults.effective.backendPort, 8080);

  const configPath = path.join(userData, "config", "config.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({
    schemaVersion: 99,
    general: { backendPort: 80, launchMode: "gpu", backendProjectPath: path.join(userData, "missing") },
  }));
  const invalid = await inspectConfiguration({ userData });
  assert.equal(invalid.status, "fail");
  assert.ok(invalid.details.issues.some((issue) => issue.includes("newer")));
  assert.ok(invalid.details.issues.some((issue) => issue.includes("backendPort")));
  assert.ok(invalid.details.issues.some((issue) => issue.includes("backendProjectPath")));

  const invalidUi = createDefaultAppConfig();
  invalidUi.ui.theme = "neon";
  invalidUi.video.previewTrialSeconds = 8;
  await fs.writeFile(configPath, JSON.stringify(invalidUi));
  const strict = await inspectConfiguration({ userData });
  assert.equal(strict.status, "fail");
  assert.ok(strict.details.issues.some((issue) => issue.includes("ui.theme")));
  assert.ok(strict.details.issues.some((issue) => issue.includes("previewTrialSeconds")));
});

test("Python diagnostics verify pinned packages, pip, backend and CPU mode", async (t) => {
  const root = await temporaryRoot(t, "moonshine-validator-python-");
  const pythonExecutable = path.join(root, "venv", "Scripts", "python.exe");
  const backendProjectPath = path.join(root, "backend");
  const lockPath = path.join(root, "requirements-cpu.lock.txt");
  await fs.mkdir(path.dirname(pythonExecutable), { recursive: true });
  await fs.mkdir(backendProjectPath, { recursive: true });
  await fs.writeFile(pythonExecutable, "placeholder");
  await fs.writeFile(lockPath, "torch==2.11.0+cpu\nrembg[cpu]==2.0.76\n");
  assert.deepEqual(parseRequirementsLock(await fs.readFile(lockPath, "utf8")), [
    { name: "torch", version: "2.11.0+cpu", extras: [] },
    { name: "rembg", version: "2.0.76", extras: ["cpu"] },
  ]);

  const structured = {
    python: { version: "3.12.10", compatible: true },
    packages: { expectedCount: 2, installedCount: 2, missing: [], mismatched: [] },
    imports: { failed: [] },
    backend: { ok: true, error: null },
    torch: { ok: true, version: "2.11.0+cpu", cudaBuild: null, cudaAvailable: false, deviceCount: 0, deviceSelected: false, operationOk: false },
  };
  const runner = async (_command, args) => args[0] === "-m"
    ? { code: 0, stdout: "No broken requirements found.\n", stderr: "" }
    : { code: 0, stdout: `warning\n__MOONSHINE_DIAGNOSTICS__${JSON.stringify(structured)}\n`, stderr: "" };
  const result = await inspectPythonEnvironment({ pythonExecutable, backendProjectPath, lockPath, flavor: "cpu", runner });
  assert.equal(result.status, "pass", JSON.stringify(result));
  assert.equal(result.details.pipCheck.ok, true);
  assert.equal(result.diagnostics.backend.ok, true);
});

test("CUDA compatibility requires driver, CUDA build, device selection and a real operation", () => {
  const host = { nvidia: { available: true, driverCompatible: true, gpus: [{ driverVersion: "580.12" }] } };
  const environment = {
    torch: {
      cudaBuild: "13.0",
      cudaAvailable: true,
      deviceCount: 1,
      deviceSelected: true,
      operationOk: true,
      device: "RTX 4090",
      capability: [8, 9],
    },
  };
  assert.equal(evaluateCudaCompatibility({ host, environment, flavor: "cu130" }).status, "pass");
  assert.equal(evaluateCudaCompatibility({ host, environment: { torch: { ...environment.torch, operationOk: false } }, flavor: "cu130" }).status, "fail");
  assert.equal(evaluateCudaCompatibility({ host, environment, flavor: "cpu" }).status, "skip");
});

test("network diagnostics use a one-byte GET fallback without downloading an archive", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(init);
    return init.method === "HEAD"
      ? new Response(null, { status: 405 })
      : new Response("x", { status: 206, headers: { "content-range": "bytes 0-0/100" } });
  };
  const result = await probeNetworkEndpoint({ id: "pypi", url: "https://pypi.org/simple/pip/", fetchImpl });
  assert.equal(result.status, "pass");
  assert.equal(result.details.method, "GET");
  assert.equal(calls[1].headers.Range, "bytes=0-0");
});

test("effective runtime diagnostics cross-check paths, processes and local service health", async (t) => {
  const userData = await temporaryRoot(t, "moonshine-validator-effective-");
  const installRoot = path.join(userData, "install");
  const serviceProjectPath = path.join(installRoot, "resources", "backend", "server");
  const environmentRoot = path.join(userData, "environments", "win-x64", "cpu", "spec");
  const pythonExecutable = path.join(environmentRoot, "venv", "Scripts", "python.exe");
  await fs.mkdir(serviceProjectPath, { recursive: true });
  await fs.mkdir(path.dirname(pythonExecutable), { recursive: true });
  await fs.writeFile(pythonExecutable, "placeholder");
  const receiptPath = path.join(userData, "diagnostics", "effective-runtime.json");
  await fs.mkdir(path.dirname(receiptPath), { recursive: true });
  await fs.writeFile(receiptPath, JSON.stringify({
    schemaVersion: 1,
    status: "running",
    appProcessId: 100,
    serviceProcessId: 101,
    serviceProjectPath,
    pythonExecutable,
    environmentRoot,
    environmentSource: "managed",
    accelerator: "cpu",
    port: 8080,
    recordedAt: "2026-08-11T00:00:00.000Z",
  }));
  const result = await inspectEffectiveRuntime({
    userData,
    installRoot,
    configuredPort: 8080,
    isProcessAlive: () => true,
    fetchImpl: async () => new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.equal(result.status, "pass", JSON.stringify(result));
  assert.equal(result.details.packagedServiceMatches, true);
  assert.equal(result.details.health.ok, true);
});

test("failure receipt diagnostics preserve the failing phase and command exit code", async (t) => {
  const userData = await temporaryRoot(t, "moonshine-validator-failure-");
  const receiptPath = path.join(userData, "environments", "last-failure.json");
  await fs.mkdir(path.dirname(receiptPath), { recursive: true });
  await fs.writeFile(receiptPath, JSON.stringify({
    failedAt: "2026-08-11T00:00:00.000Z",
    phase: "install-requirements",
    selectedAccelerator: "cpu",
    error: {
      code: "ENVIRONMENT_COMMAND_FAILED",
      message: "Dependency installation failed",
      details: { result: { command: "python.exe", code: 23, stderr: "No matching distribution" } },
    },
  }));
  const result = await inspectFailureReceipt({ userData });
  assert.equal(result.status, "fail");
  assert.equal(result.details.phase, "install-requirements");
  assert.equal(result.details.exitCode, 23);
  assert.match(result.details.diagnostic, /Dependency installation failed/);
});

test("configured service probe starts an isolated local-files-only service and cleans it up", async (t) => {
  const root = await temporaryRoot(t, "moonshine-validator-service-");
  const pythonExecutable = path.join(root, "venv", "Scripts", "python.exe");
  const serviceProjectPath = path.join(root, "service");
  await fs.mkdir(path.dirname(pythonExecutable), { recursive: true });
  await fs.mkdir(serviceProjectPath, { recursive: true });
  await fs.writeFile(pythonExecutable, "placeholder");
  await fs.writeFile(path.join(serviceProjectPath, "main.py"), "# placeholder");
  let spawned = null;
  let terminated = false;
  const child = new EventEmitter();
  child.pid = 43210;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const result = await probeConfiguredService({
    pythonExecutable,
    serviceProjectPath,
    flavor: "cpu",
    launchMode: "cpu",
    reservePort: async () => 43123,
    spawnImpl: (command, args, options) => {
      spawned = { command, args, options };
      queueMicrotask(() => child.stdout.write("service starting\n"));
      return child;
    },
    fetchImpl: async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
    terminateImpl: async (ownedChild) => {
      assert.equal(ownedChild, child);
      terminated = true;
      child.exitCode = 0;
      child.emit("close", 0, null);
      return { requested: true, exited: true, method: "test" };
    },
  });
  assert.equal(result.status, "pass", JSON.stringify(result));
  assert.equal(spawned.command, pythonExecutable);
  assert.ok(spawned.args.includes("--port=43123"));
  assert.ok(spawned.args.includes("--device=cpu"));
  assert.ok(spawned.args.includes("--local-files-only"));
  assert.equal(spawned.options.cwd, serviceProjectPath);
  assert.equal(terminated, true);
  assert.equal(result.details.health.ok, true);
});

test("configured service probe rejects a CUDA configuration backed by a CPU environment", async (t) => {
  const root = await temporaryRoot(t, "moonshine-validator-service-mismatch-");
  const pythonExecutable = path.join(root, "venv", "Scripts", "python.exe");
  const serviceProjectPath = path.join(root, "service");
  await fs.mkdir(path.dirname(pythonExecutable), { recursive: true });
  await fs.mkdir(serviceProjectPath, { recursive: true });
  await fs.writeFile(pythonExecutable, "placeholder");
  await fs.writeFile(path.join(serviceProjectPath, "main.py"), "# placeholder");
  let spawned = false;
  const result = await probeConfiguredService({
    pythonExecutable,
    serviceProjectPath,
    flavor: "cpu",
    launchMode: "cuda",
    spawnImpl: () => { spawned = true; },
  });
  assert.equal(result.status, "fail");
  assert.equal(spawned, false);
  assert.match(result.details.issues.join("\n"), /requires cu130/);
});
