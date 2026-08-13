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
    const persisted = JSON.parse(await fs.readFile(path.join(root, "environments", "preference.json"), "utf8"));
    assert.equal(persisted.schema, 2);
    assert.equal(persisted.preference, "cu130");
    assert.equal(persisted.explicit, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("environment manager ignores unsafe Python pointers and resolves the final venv", async () => {
  const { root, manager } = await makeManager();
  try {
    const activePath = path.join(root, "environments", "win-x64", "cpu", "hash");
    manager.active = {
      absolutePath: activePath,
      pythonExecutableRelative: "../../.staging/old/venv/Scripts/python.exe",
    };

    assert.equal(
      manager._activePythonExecutable(),
      path.join(activePath, "venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python"),
    );
    assert.equal(manager.getActiveBackendSpec().pythonExecutable, manager._activePythonExecutable());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("environment manager migrates an ambiguous legacy CPU preference back to auto", async () => {
  const { root, manager } = await makeManager();
  try {
    await fs.mkdir(path.join(root, "environments"), { recursive: true });
    await fs.writeFile(
      path.join(root, "environments", "preference.json"),
      `${JSON.stringify({ preference: "cpu" })}\n`,
    );
    manager.bootstrap.getActive = async () => null;

    await manager.initialize();

    assert.equal(manager.getState().preference, "auto");
    assert.equal(manager.getState().preferenceExplicit, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cu130 capability failure preserves an existing managed environment", async () => {
  const { root, manager } = await makeManager();
  try {
    const activePath = path.join(root, "environments", "win-x64", "cpu", "hash");
    const active = {
      absolutePath: activePath,
      path: "environments/win-x64/cpu/hash",
      accelerator: "cpu",
      specHash: "hash",
    };
    manager.active = active;
    manager.bootstrap.getActive = async () => active;
    manager.bootstrap.bootstrap = async () => ({
      success: false,
      code: "ENVIRONMENT_CU130_UNAVAILABLE",
      error: "英伟达驱动低于 CUDA 13.0 最低所需版本，请更新英伟达驱动。",
      details: { minimumDriverMajor: 570 },
    });

    const result = await manager.ensure({ accelerator: "cu130" });

    assert.equal(result.success, false);
    assert.equal(result.capabilityWarning, true);
    assert.equal(result.preservedActive, true);
    assert.equal(manager.getState().status, "ready");
    assert.equal(manager.getState().activePath, activePath);
    assert.equal(manager.getState().error, null);
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
    assert.equal(manager.getActiveBackendSpec().ffmpegRoot, path.dirname(path.join(root, "ffmpeg.exe")));
    assert.equal(manager.getActiveBackendSpec().ffmpegPath, path.join(root, "ffmpeg.exe"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("environment manager keeps a FFmpeg-degraded managed environment usable", async () => {
  const { root, manager, ffmpeg } = await makeManager();
  try {
    const activePath = path.join(root, "environments", "win-x64", "cpu", "hash");
    const active = { absolutePath: activePath, path: "environments/win-x64/cpu/hash", accelerator: "cpu", specHash: "hash" };
    manager.bootstrap.bootstrap = async () => ({
      success: true,
      degraded: true,
      selection: { selectedAccelerator: "cpu", reason: "manual-cpu" },
      state: { steps: [], status: "degraded" },
      health: {
        success: true,
        degraded: true,
        python: { ok: true, version: "3.12.11" },
        torch: { ok: true, version: "2.11.0+cpu" },
        cuda: { ok: true, available: false },
        backend: { ok: true },
        ffmpeg: { ok: false, path: ffmpeg },
        capabilities: { core: true, image: true, video: false, ffmpeg: false },
      },
    });
    manager.bootstrap.getActive = async () => active;

    const result = await manager.ensure({ accelerator: "cpu" });
    assert.equal(result.success, true);
    assert.equal(manager.getState().status, "degraded");
    assert.equal(manager.getState().videoAvailable, false);
    assert.equal(manager.getActiveBackendSpec().pythonExecutable, path.join(activePath, "venv", "Scripts", "python.exe"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("environment manager cancels one active preparation and restores the previous state", async () => {
  const { root, manager } = await makeManager();
  try {
    manager.bootstrap.getActive = async () => null;
    manager.bootstrap.bootstrap = async ({ signal, onProgress }) => {
      onProgress?.({ phase: "install-requirements", status: "running", percent: 60 });
      if (!signal.aborted) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      }
      return {
        success: false,
        cancelled: true,
        code: "ENVIRONMENT_PREPARATION_CANCELLED",
        error: "运行环境准备已取消。",
        state: { status: "cancelled", steps: [] },
      };
    };

    const pending = manager.ensure({ accelerator: "cpu" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.getState().canCancel, true);
    assert.ok(manager.getState().operationId);
    const cancelled = manager.cancelPreparation();
    assert.equal(cancelled.success, true);
    assert.equal(manager.getState().status, "cancelling");
    const result = await pending;
    assert.equal(result.cancelled, true);
    assert.equal(manager.getState().status, "needs-create");
    assert.equal(manager.getState().canCancel, false);
    assert.equal(manager.getState().operationId, null);
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

test("environment update status is read-only and a confirmed switch prepares the selected environment", async () => {
  const { root, manager } = await makeManager();
  try {
    const cpuPath = path.join(root, "environments", "win-x64", "cpu", "cpu-hash");
    const cudaPath = path.join(root, "environments", "win-x64", "cu130", "cuda-hash");
    const cpuActive = {
      absolutePath: cpuPath,
      path: "environments/win-x64/cpu/cpu-hash",
      accelerator: "cpu",
      specHash: "cpu-hash",
    };
    const cudaActive = {
      absolutePath: cudaPath,
      path: "environments/win-x64/cu130/cuda-hash",
      accelerator: "cu130",
      specHash: "cuda-hash",
    };
    const selection = {
      selectedAccelerator: "cu130",
      reason: "auto-nvidia-compatible",
      nvidia: {
        available: true,
        compatible: true,
        gpuName: "NVIDIA GeForce RTX 4060 Ti",
        driverVersion: "576.88",
        driverMajor: 576,
        reason: "",
      },
    };
    const health = {
      success: true,
      python: { version: "3.12.11" },
      torch: { version: "2.11.0+cu130" },
      cuda: { available: true, version: "13.0" },
      ffmpeg: { ok: true, version: "8.0" },
      capabilities: { core: true, image: true, video: true, ffmpeg: true },
    };
    manager._applyActive(cpuActive, { status: "ready", error: null });
    manager._applyDiagnostics({
      ...health,
      torch: { version: "2.11.0+cpu" },
      cuda: { available: false, version: null },
    });
    manager.bootstrap.detector = async () => selection;
    manager.bootstrap.bootstrap = async ({ accelerator }) => {
      assert.equal(accelerator, "cu130");
      return { success: true, created: true, selection, health, state: { steps: [] } };
    };
    manager.bootstrap.getActive = async () => cudaActive;

    const stateBeforeStatus = manager.getState();
    const status = await manager.getUpdateStatus();
    assert.equal(status.success, true);
    assert.equal(status.available, true);
    assert.equal(status.python.version, "3.12.11");
    assert.equal(status.torch.version, "2.11.0+cpu");
    assert.equal(status.nvidiaDeviceName, "NVIDIA GeForce RTX 4060 Ti");
    assert.equal(status.nvidiaDriverVersion, "576.88");
    assert.equal(status.canSwitchToCu130, true);
    assert.equal(status.canSwitchToCpu, false);
    assert.equal(manager.getState().nvidiaDeviceName, stateBeforeStatus.nvidiaDeviceName);

    const plan = await manager.getUpdatePlan({ target: "cu130" });
    assert.equal(plan.success, true);
    assert.equal(plan.allowed, true);
    assert.equal(plan.requiresConfirmation, true);

    const switched = await manager.switchEnvironment({ target: "cu130", confirmed: true });
    assert.equal(switched.success, true);
    assert.equal(switched.needsPrepare, false);
    assert.equal(switched.state.selectedAccelerator, "cu130");
    assert.equal(switched.state.nvidiaDeviceName, "NVIDIA GeForce RTX 4060 Ti");
    assert.equal(switched.state.canSwitchToCpu, true);
    assert.equal(switched.updateStatus.available, true);
    const persisted = JSON.parse(await fs.readFile(path.join(root, "environments", "preference.json"), "utf8"));
    assert.equal(persisted.preference, "cu130");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("environment update plan blocks cu130 without a compatible NVIDIA driver before bootstrap", async () => {
  const { root, manager } = await makeManager();
  try {
    const active = {
      absolutePath: path.join(root, "environments", "win-x64", "cpu", "cpu-hash"),
      path: "environments/win-x64/cpu/cpu-hash",
      accelerator: "cpu",
      specHash: "cpu-hash",
    };
    manager._applyActive(active, { status: "ready", error: null });
    manager._applyDiagnostics({
      success: true,
      python: { version: "3.12.11" },
      torch: { version: "2.11.0+cpu" },
      cuda: { available: false, version: null },
    });
    manager.bootstrap.detector = async () => ({
      selectedAccelerator: "cpu",
      reason: "driver-too-old",
      nvidia: {
        available: true,
        compatible: false,
        gpuName: "NVIDIA GeForce RTX 4060 Ti",
        driverVersion: "560.94",
        driverMajor: 560,
        reason: "NVIDIA driver 560.94 is below the cu130 minimum (570)",
      },
    });
    let bootstrapCalls = 0;
    manager.bootstrap.bootstrap = async () => {
      bootstrapCalls += 1;
      return { success: true };
    };

    const plan = await manager.getUpdatePlan({ target: "cu130" });
    assert.equal(plan.success, false);
    assert.equal(plan.allowed, false);
    assert.equal(plan.code, "ENVIRONMENT_CU130_UNAVAILABLE");
    assert.match(plan.reason, /560\.94/);
    assert.match(plan.requiredAction, /570\+/);

    const status = await manager.getUpdateStatus();
    assert.match(status.acceleratorChangeReason, /560\.94/);
    assert.match(status.acceleratorChangeReason, /570\+/);
    assert.match(status.acceleratorChangeReason, /升级 NVIDIA 驱动后重新检测/);

    const switched = await manager.switchEnvironment({ target: "cu130", confirmed: true });
    assert.equal(switched.success, false);
    assert.equal(switched.allowed, false);
    assert.equal(bootstrapCalls, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("environment update inspection remains available for a degraded but usable environment", async () => {
  const { root, manager } = await makeManager();
  try {
    const active = {
      absolutePath: path.join(root, "environments", "win-x64", "cpu", "cpu-hash"),
      path: "environments/win-x64/cpu/cpu-hash",
      accelerator: "cpu",
      specHash: "cpu-hash",
    };
    manager._applyActive(active, { status: "degraded", error: null });
    manager._applyDiagnostics({
      success: true,
      degraded: true,
      python: { version: "3.12.11" },
      torch: { version: "2.11.0+cpu" },
      cuda: { available: false, version: null },
      ffmpeg: { ok: false, version: null },
      capabilities: { core: true, image: true, video: false, ffmpeg: false },
    });
    manager.bootstrap.detector = async () => ({
      selectedAccelerator: "cpu",
      reason: "no-nvidia",
      nvidia: { available: false, compatible: false, reason: "NVIDIA 未检测到" },
    });

    const status = await manager.getUpdateStatus();
    assert.equal(status.success, true);
    assert.equal(status.available, true);
    assert.equal(status.status, "degraded");
    assert.equal(status.python.version, "3.12.11");
    assert.equal(status.torch.version, "2.11.0+cpu");
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

test("forgetting an external environment restores a usable FFmpeg-degraded managed environment", async () => {
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
      degraded: true,
      python: { version: "3.12.11" },
      torch: { version: "2.11.0+cpu" },
      cuda: { available: false, version: null },
      ffmpeg: { ok: false, version: null },
      capabilities: { core: true, image: true, video: false, ffmpeg: false },
    });
    await manager.initialize();
    assert.equal(manager.getState().source, "external");

    const result = await manager.forgetExternalEnvironment();
    assert.equal(result.success, true);
    assert.equal(forgotten, true);
    assert.equal(manager.getState().source, "managed");
    assert.equal(manager.getState().status, "degraded");
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
