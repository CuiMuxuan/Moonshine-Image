import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EnvironmentManager } from "../../src-electron/runtime/environment-manager.js";

async function makeManager(overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moonshine-environment-manager-"));
  const backend = path.join(root, "backend");
  const ffmpeg = path.join(root, "ffmpeg.exe");
  await fs.mkdir(backend, { recursive: true });
  await fs.writeFile(path.join(backend, "requirements.txt"), "torch==2.0.0\n");
  await fs.writeFile(ffmpeg, "ffmpeg-test");
  const manager = new EnvironmentManager({
    userData: root,
    appVersion: "1.3.0",
    backendProjectPath: backend,
    requirementsPath: path.join(backend, "requirements.txt"),
    ffmpegSourcePath: ffmpeg,
    enabled: true,
    ...overrides,
  });
  return { root, backend, ffmpeg, manager };
}

function externalEnvironment({ backend, ffmpeg, reprobe, probe, activate, forget } = {}) {
  return {
    ffmpegPath: ffmpeg,
    reprobeConfigured: reprobe || (async () => ({ success: true, config: null })),
    probeDirectory: probe || (async () => ({ success: false, code: "NOT_CONFIGURED" })),
    activateCandidate: activate || (async () => ({ success: false, code: "NO_CANDIDATE" })),
    forget: forget || (async () => ({ success: true })),
    backend,
  };
}

function externalResult(root, { accelerator = "cpu", fingerprint = "f".repeat(64) } = {}) {
  const normalizedPath = path.join(root, "external-runtime");
  const pythonExecutable = path.join(normalizedPath, "python.exe");
  const environment = {
    selectedPath: normalizedPath,
    normalizedPath,
    layout: "conda",
    pythonExecutableRelative: "python.exe",
    pythonExecutable,
    pythonVersion: "3.12.11",
    pythonBits: 64,
    torchVersion: accelerator === "cu130" ? "2.11.0+cu130" : "2.11.0+cpu",
    cudaVersion: accelerator === "cu130" ? "13.0" : null,
    cudaAvailable: accelerator === "cu130",
    cudaDeviceCount: accelerator === "cu130" ? 1 : 0,
    accelerator,
    fingerprint,
  };
  const diagnostics = {
    success: true,
    python: { ok: true, version: environment.pythonVersion },
    torch: { ok: true, version: environment.torchVersion },
    cuda: { ok: true, available: environment.cudaAvailable, version: environment.cudaVersion },
    ffmpeg: { ok: true, version: "ffmpeg version 8.0" },
  };
  return {
    success: true,
    environment,
    diagnostics,
    config: {
      schema: 1,
      environment: { ...environment, lastVerifiedAt: "2026-08-09T00:00:00.000Z" },
      lastVerifiedAt: "2026-08-09T00:00:00.000Z",
    },
  };
}

test("environment manager starts without an active environment and persists accelerator preference", async () => {
  const { root, manager } = await makeManager();
  try {
    manager.bootstrap.getActive = async () => null;
    await manager.initialize();
    assert.equal(manager.getState().status, "needs-create");

    const result = await manager.setAccelerator("cu130");
    assert.equal(result.success, true);
    assert.equal(manager.getState().preference, "cu130");
    assert.equal(JSON.parse(await fs.readFile(path.join(root, "environments", "preference.json"), "utf8")).preference, "cu130");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("environment manager exposes the active backend spec after a successful bootstrap", async () => {
  const { root, manager } = await makeManager();
  try {
    const activePath = path.join(root, "environments", "win-x64", "cpu", "hash");
    const active = { absolutePath: activePath, path: "environments/win-x64/cpu/hash", accelerator: "cpu", specHash: "hash" };
    manager.bootstrap.bootstrap = async () => ({
      success: true,
      selection: { selectedAccelerator: "cpu", reason: "manual-cpu" },
      state: { steps: [] },
      health: { success: true },
    });
    manager.bootstrap.getActive = async () => active;

    const result = await manager.ensure({ accelerator: "cpu" });
    assert.equal(result.success, true);
    assert.equal(manager.getState().status, "ready");
    assert.equal(manager.getState().restartRequired, true);
    assert.equal(manager.getActiveBackendSpec().pythonExecutable, path.join(activePath, "venv", "Scripts", "python.exe"));
    assert.equal(manager.getActiveBackendSpec().ffmpegRoot, path.join(activePath, "ffmpeg"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("environment manager refuses activation while the backend is busy", async () => {
  const { root } = await makeManager();
  try {
    const blocked = new EnvironmentManager({
      userData: root,
      appVersion: "1.3.0",
      backendProjectPath: path.join(root, "backend"),
      requirementsPath: path.join(root, "backend", "requirements.txt"),
      ffmpegSourcePath: path.join(root, "ffmpeg.exe"),
      enabled: true,
      canActivate: async () => false,
    });
    const result = await blocked.ensure({ accelerator: "cpu" });
    assert.equal(result.success, false);
    assert.equal(result.code, "ENVIRONMENT_BUSY");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("environment manager probes a candidate without switching source and activates only its token", async () => {
  const seed = await makeManager();
  const result = externalResult(seed.root);
  const external = externalEnvironment({
    backend: seed.backend,
    ffmpeg: seed.ffmpeg,
    probe: async ({ directoryPath }) => ({
      ...result,
      environment: { ...result.environment, normalizedPath: directoryPath },
      candidateToken: "candidate-token",
      candidateExpiresAt: Date.now() + 60_000,
    }),
    activate: async ({ candidateToken }) => {
      assert.equal(candidateToken, "candidate-token");
      return result;
    },
  });
  const { root, backend, manager } = await makeManager({ externalEnvironment: external });
  try {
    manager.bootstrap.getActive = async () => null;
    await manager.initialize();
    const probed = await manager.probeExternalEnvironment({ directoryPath: result.environment.normalizedPath });
    assert.equal(probed.success, true);
    assert.equal(manager.getState().source, "managed");
    assert.equal(manager.getState().externalCandidateToken, "candidate-token");

    const activated = await manager.activateExternalEnvironment({ candidateToken: "candidate-token" });
    assert.equal(activated.success, true);
    assert.equal(manager.getState().source, "external");
    assert.equal(manager.getState().status, "ready");
    assert.equal(manager.getState().externalConfigured, true);
    assert.equal(manager.getState().restartRequired, true);
    assert.equal(manager.getActiveBackendSpec().source, "external");
    assert.equal(manager.getActiveBackendSpec().pythonExecutable, result.environment.pythonExecutable);
    assert.equal(manager.getActiveBackendSpec().backendProjectPath, backend);
    assert.equal(manager.getActiveBackendSpec().ffmpegPath, seed.ffmpeg);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(seed.root, { recursive: true, force: true });
  }
});

test("startup re-probes configured external environments and blocks backend launch after failure", async () => {
  const seed = await makeManager();
  const configured = externalResult(seed.root, { accelerator: "cu130" });
  let healthy = true;
  const external = externalEnvironment({
    backend: seed.backend,
    ffmpeg: seed.ffmpeg,
    reprobe: async () => healthy
      ? configured
      : { success: false, code: "EXTERNAL_ENV_CHANGED_AFTER_PROBE", message: "changed", config: configured.config },
  });
  const { root, manager } = await makeManager({ externalEnvironment: external });
  try {
    manager.bootstrap.getActive = async () => null;
    await manager.initialize();
    assert.equal(manager.getState().source, "external");
    assert.equal(manager.getState().status, "ready");
    assert.equal(manager.getActiveBackendSpec().accelerator, "cu130");

    healthy = false;
    const checked = await manager.check();
    assert.equal(checked.success, false);
    assert.equal(manager.getState().status, "needs-repair");
    assert.deepEqual(manager.getActiveBackendSpec(), {});
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(seed.root, { recursive: true, force: true });
  }
});

test("forgetting an external environment restores a healthy managed environment", async () => {
  const seed = await makeManager();
  const configured = externalResult(seed.root);
  let forgotten = false;
  const external = externalEnvironment({
    backend: seed.backend,
    ffmpeg: seed.ffmpeg,
    reprobe: async () => configured,
    forget: async () => { forgotten = true; return { success: true }; },
  });
  const { root, manager } = await makeManager({ externalEnvironment: external });
  try {
    const managedPath = path.join(root, "environments", "win-x64", "cpu", "managed-hash");
    const managed = {
      absolutePath: managedPath,
      path: "environments/win-x64/cpu/managed-hash",
      accelerator: "cpu",
      specHash: "managed-hash",
    };
    manager.bootstrap.getActive = async () => managed;
    manager.bootstrap.check = async () => ({
      success: true,
      ready: true,
      active: managed,
      selectedAccelerator: "cpu",
      selection: { selectedAccelerator: "cpu", reason: "manual-cpu" },
    });
    manager.bootstrap.probe = async () => ({
      success: true,
      python: { version: "3.12.11" },
      torch: { version: "2.11.0+cpu" },
      cuda: { available: false, version: null },
      ffmpeg: { version: "ffmpeg version 8.0" },
    });
    await manager.initialize();
    assert.equal(manager.getState().source, "external");

    const result = await manager.forgetExternalEnvironment();
    assert.equal(result.success, true);
    assert.equal(forgotten, true);
    assert.equal(manager.getState().source, "managed");
    assert.equal(manager.getState().status, "ready");
    assert.equal(manager.getState().externalConfigured, false);
    assert.equal(manager.getActiveBackendSpec().source, "managed");
    assert.equal(manager.getActiveBackendSpec().specHash, "managed-hash");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(seed.root, { recursive: true, force: true });
  }
});

test("external source is read-only for ensure and managed rollback", async () => {
  const seed = await makeManager();
  const configured = externalResult(seed.root);
  let bootstrapCalls = 0;
  const external = externalEnvironment({
    backend: seed.backend,
    ffmpeg: seed.ffmpeg,
    reprobe: async () => configured,
  });
  const { root, manager } = await makeManager({ externalEnvironment: external });
  try {
    manager.bootstrap.getActive = async () => null;
    manager.bootstrap.bootstrap = async () => { bootstrapCalls += 1; return { success: true }; };
    await manager.initialize();
    const ensured = await manager.ensure({ force: true });
    assert.equal(ensured.success, true);
    assert.equal(bootstrapCalls, 0);
    const rollback = await manager.rollback();
    assert.equal(rollback.code, "EXTERNAL_ENV_READ_ONLY");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(seed.root, { recursive: true, force: true });
  }
});
