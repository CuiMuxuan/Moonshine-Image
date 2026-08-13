import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EXTERNAL_ENVIRONMENT_LAYOUTS,
  ExternalEnvironmentService,
  probeExternalEnvironment,
  resolveExternalEnvironmentLayout,
} from "../../src-electron/runtime/external-environment.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moonshine-external-environment-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const backend = path.join(root, "bundled-backend");
  const ffmpeg = path.join(root, "bundled-ffmpeg.exe");
  await fs.mkdir(backend, { recursive: true });
  await fs.writeFile(ffmpeg, "ffmpeg");
  return { root, backend, ffmpeg };
}

async function makeLayout(root, layout, { runtimeFlavor = "cpu" } = {}) {
  const directory = path.join(root, `${layout}-environment`);
  await fs.mkdir(directory, { recursive: true });
  if (layout === EXTERNAL_ENVIRONMENT_LAYOUTS.RUNTIME_MANIFEST) {
    await fs.mkdir(path.join(directory, "env"), { recursive: true });
    await fs.writeFile(path.join(directory, "env", "python.exe"), "python");
    await fs.writeFile(path.join(directory, "runtime-manifest.json"), JSON.stringify({
      schemaVersion: 4,
      runtimeFlavor,
      pythonExecutable: "env/python.exe",
    }));
  } else if (layout === EXTERNAL_ENVIRONMENT_LAYOUTS.CONDA) {
    await fs.writeFile(path.join(directory, "python.exe"), "python");
  } else {
    await fs.mkdir(path.join(directory, "Scripts"), { recursive: true });
    await fs.writeFile(path.join(directory, "Scripts", "python.exe"), "python");
    await fs.writeFile(path.join(directory, "pyvenv.cfg"), "home = C:\\Python312\n");
  }
  return directory;
}

function healthyRunner({ pythonVersion = "3.12.11", bits = 64, cuda = false, failStage = "", backendPath } = {}) {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (options.stage === failStage) return { success: false, code: 1, stderr: `${failStage} failed` };
    if (options.stage === "external-environment-python") {
      return {
        code: 0,
        stdout: JSON.stringify({ implementation: "CPython", version: pythonVersion, bits, executable: command }),
      };
    }
    if (options.stage === "external-environment-torch") {
      return {
        code: 0,
        stdout: JSON.stringify({
          version: cuda ? "2.11.0+cu130" : "2.11.0+cpu",
          cudaVersion: cuda ? "13.0" : null,
          cudaAvailable: cuda,
          deviceCount: cuda ? 1 : 0,
        }),
      };
    }
    if (options.stage === "external-environment-backend") {
      assert.equal(options.env.PYTHONPATH, backendPath);
      assert.equal(options.env.PYTHONDONTWRITEBYTECODE, "1");
      return { code: 0, stdout: "ok" };
    }
    if (options.stage === "external-environment-ffmpeg") return { code: 0, stdout: "ffmpeg version 8.0" };
    return { code: 0, stdout: "No broken requirements found.\n" };
  };
  return { runner, calls };
}

test("external layout resolution accepts only deterministic runtime-manifest, conda, and venv roots", async (t) => {
  const data = await fixture(t);
  for (const layout of Object.values(EXTERNAL_ENVIRONMENT_LAYOUTS)) {
    const directory = await makeLayout(data.root, layout);
    const resolved = await resolveExternalEnvironmentLayout(directory, { platform: "win32" });
    assert.equal(resolved.layout, layout);
    assert.ok(path.isAbsolute(resolved.normalizedPath));
    assert.ok(path.isAbsolute(resolved.pythonExecutable));
    assert.match(resolved.fingerprint, /^[a-f0-9]{64}$/);
  }

  const unsupported = path.join(data.root, "unsupported");
  await fs.mkdir(path.join(unsupported, "nested", "Scripts"), { recursive: true });
  await fs.writeFile(path.join(unsupported, "nested", "Scripts", "python.exe"), "python");
  await assert.rejects(
    resolveExternalEnvironmentLayout(unsupported, { platform: "win32" }),
    (error) => error.code === "EXTERNAL_ENV_LAYOUT_UNSUPPORTED",
  );
});

test("runtime manifest rejects absolute and escaping Python paths", async (t) => {
  const data = await fixture(t);
  const directory = await makeLayout(data.root, EXTERNAL_ENVIRONMENT_LAYOUTS.RUNTIME_MANIFEST);
  const manifestPath = path.join(directory, "runtime-manifest.json");
  for (const pythonExecutable of [path.join(directory, "env", "python.exe"), "../python.exe"]) {
    await fs.writeFile(manifestPath, JSON.stringify({ pythonExecutable }));
    await assert.rejects(
      resolveExternalEnvironmentLayout(directory, { platform: "win32" }),
      (error) => ["EXTERNAL_ENV_PATH_INVALID", "EXTERNAL_ENV_PATH_ESCAPE"].includes(error.code),
    );
  }
});

test("external probe accepts 64-bit CPython 3.12.x and uses bundled backend plus FFmpeg read-only", async (t) => {
  const data = await fixture(t);
  const directory = await makeLayout(data.root, EXTERNAL_ENVIRONMENT_LAYOUTS.VENV);
  const before = await fs.readFile(path.join(directory, "Scripts", "python.exe"), "utf8");
  for (const version of ["3.12.0", "3.12.10", "3.12.11"]) {
    const { runner, calls } = healthyRunner({ pythonVersion: version, backendPath: data.backend });
    const result = await probeExternalEnvironment({
      directoryPath: directory,
      backendProjectPath: data.backend,
      ffmpegPath: data.ffmpeg,
      runner,
      platform: "win32",
    });
    assert.equal(result.environment.pythonVersion, version);
    assert.equal(result.environment.accelerator, "cpu");
    assert.equal(calls.find(({ options }) => options.stage === "external-environment-ffmpeg").command, data.ffmpeg);
    assert.ok(calls.some(({ args }) => args.join(" ") === "-m pip check"));
    assert.ok(!calls.some(({ args }) => args.includes("install") || args.includes("uninstall")));
  }
  assert.equal(await fs.readFile(path.join(directory, "Scripts", "python.exe"), "utf8"), before);
});

test("external probe returns stable errors for Python, torch, CUDA, pip, and backend failures", async (t) => {
  const data = await fixture(t);
  const cpuDirectory = await makeLayout(data.root, EXTERNAL_ENVIRONMENT_LAYOUTS.CONDA);
  for (const [options, code] of [
    [{ pythonVersion: "3.11.9" }, "EXTERNAL_ENV_PYTHON_VERSION_UNSUPPORTED"],
    [{ pythonVersion: "3.13.0" }, "EXTERNAL_ENV_PYTHON_VERSION_UNSUPPORTED"],
    [{ bits: 32 }, "EXTERNAL_ENV_ARCH_UNSUPPORTED"],
    [{ failStage: "external-environment-torch" }, "EXTERNAL_ENV_TORCH_UNAVAILABLE"],
    [{ failStage: "external-environment-pip-check" }, "EXTERNAL_ENV_DEPENDENCIES_BROKEN"],
    [{ failStage: "external-environment-backend" }, "EXTERNAL_ENV_BACKEND_IMPORT_FAILED"],
  ]) {
    const { runner } = healthyRunner({ ...options, backendPath: data.backend });
    await assert.rejects(
      probeExternalEnvironment({ directoryPath: cpuDirectory, backendProjectPath: data.backend, ffmpegPath: data.ffmpeg, runner, platform: "win32" }),
      (error) => error.code === code,
    );
  }

  const cudaDirectory = await makeLayout(data.root, EXTERNAL_ENVIRONMENT_LAYOUTS.RUNTIME_MANIFEST, { runtimeFlavor: "cu130" });
  const { runner } = healthyRunner({ cuda: false, backendPath: data.backend });
  await assert.rejects(
    probeExternalEnvironment({ directoryPath: cudaDirectory, backendProjectPath: data.backend, ffmpegPath: data.ffmpeg, runner, platform: "win32" }),
    (error) => error.code === "EXTERNAL_ENV_CUDA_UNAVAILABLE",
  );
});

test("external probe keeps the Python environment valid when bundled FFmpeg is unavailable", async (t) => {
  const data = await fixture(t);
  const directory = await makeLayout(data.root, EXTERNAL_ENVIRONMENT_LAYOUTS.VENV);
  const { runner } = healthyRunner({ failStage: "external-environment-ffmpeg", backendPath: data.backend });
  const result = await probeExternalEnvironment({
    directoryPath: directory,
    backendProjectPath: data.backend,
    ffmpegPath: data.ffmpeg,
    runner,
    platform: "win32",
  });

  assert.equal(result.success, true);
  assert.equal(result.diagnostics.degraded, true);
  assert.equal(result.diagnostics.ffmpeg.ok, false);
  assert.equal(result.diagnostics.capabilities.video, false);
  assert.match(result.diagnostics.warnings[0], /FFmpeg/);
});

test("candidate tokens expire and activation rejects a changed Python fingerprint", async (t) => {
  const data = await fixture(t);
  const directory = await makeLayout(data.root, EXTERNAL_ENVIRONMENT_LAYOUTS.VENV);
  let now = Date.parse("2026-08-09T00:00:00.000Z");
  let token = 0;
  const { runner } = healthyRunner({ backendPath: data.backend });
  const service = new ExternalEnvironmentService({
    userData: data.root,
    backendProjectPath: data.backend,
    ffmpegPath: data.ffmpeg,
    runner,
    platform: "win32",
    now: () => now,
    randomUUID: () => `candidate-${++token}`,
    candidateTtlMs: 1_000,
  });

  const first = await service.probeDirectory({ directoryPath: directory });
  assert.equal(first.success, true);
  await fs.writeFile(path.join(directory, "Scripts", "python.exe"), "changed-python");
  const changed = await service.activateCandidate({ candidateToken: first.candidateToken });
  assert.equal(changed.success, false);
  assert.equal(changed.code, "EXTERNAL_ENV_CHANGED_AFTER_PROBE");

  await fs.writeFile(path.join(directory, "Scripts", "python.exe"), "python");
  const second = await service.probeDirectory({ directoryPath: directory });
  now += 1_001;
  const expired = await service.activateCandidate({ candidateToken: second.candidateToken });
  assert.equal(expired.code, "EXTERNAL_ENV_CANDIDATE_INVALID");
});

test("activation writes an atomic config and startup re-probe detects later changes", async (t) => {
  const data = await fixture(t);
  const directory = await makeLayout(data.root, EXTERNAL_ENVIRONMENT_LAYOUTS.CONDA);
  const { runner } = healthyRunner({ backendPath: data.backend });
  const service = new ExternalEnvironmentService({
    userData: data.root,
    backendProjectPath: data.backend,
    ffmpegPath: data.ffmpeg,
    runner,
    platform: "win32",
    randomUUID: () => "candidate",
  });
  const candidate = await service.probeDirectory({ directoryPath: directory });
  const activated = await service.activateCandidate({ candidateToken: candidate.candidateToken });
  assert.equal(activated.success, true, JSON.stringify(activated));
  const configPath = path.join(data.root, "environments", "external.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(config.environment.layout, "conda");
  assert.equal(config.environment.fingerprint, activated.environment.fingerprint);

  const reprobe = await service.reprobeConfigured();
  assert.equal(reprobe.success, true);
  await fs.writeFile(path.join(directory, "python.exe"), "changed");
  const changed = await service.reprobeConfigured();
  assert.equal(changed.code, "EXTERNAL_ENV_CHANGED_AFTER_PROBE");
  assert.equal(await fs.readFile(path.join(directory, "python.exe"), "utf8"), "changed");
});
