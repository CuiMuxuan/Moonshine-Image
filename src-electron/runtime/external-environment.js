import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { createIsolatedPythonEnv } from "../python-runtime.js";
import { runStartupProcess } from "../startup-process.js";
import { writeJsonAtomic } from "./runtime-layout.js";

export const EXTERNAL_ENVIRONMENT_SCHEMA = 1;
export const DEFAULT_EXTERNAL_CANDIDATE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_EXTERNAL_PROBE_TIMEOUT_MS = 30_000;
export const EXTERNAL_ENVIRONMENT_LAYOUTS = Object.freeze({
  RUNTIME_MANIFEST: "runtime-manifest",
  CONDA: "conda",
  VENV: "venv",
});

const PYTHON_IDENTITY_SCRIPT = [
  "import json, platform, struct, sys",
  "print(json.dumps({'implementation': platform.python_implementation(), 'version': platform.python_version(), 'bits': struct.calcsize('P') * 8, 'executable': sys.executable}))",
].join("; ");

const TORCH_IDENTITY_SCRIPT = [
  "import json, torch",
  "print(json.dumps({'version': getattr(torch, '__version__', ''), 'cudaVersion': getattr(torch.version, 'cuda', None), 'cudaAvailable': bool(torch.cuda.is_available()), 'deviceCount': int(torch.cuda.device_count()) if torch.cuda.is_available() else 0}))",
].join("; ");

const BACKEND_IMPORT_SCRIPT = "import moonshine_server; print('ok')";

export class ExternalEnvironmentError extends Error {
  constructor(message, code = "EXTERNAL_ENV_FAILED", details = {}) {
    super(message);
    this.name = "ExternalEnvironmentError";
    this.code = code;
    this.details = details;
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeError(error, fallbackCode = "EXTERNAL_ENV_FAILED") {
  return {
    message: error?.message || String(error),
    code: error?.code || fallbackCode,
    details: clone(error?.details || {}),
  };
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function normalizeSafeRelative(value, label) {
  const raw = String(value ?? "").trim();
  const normalized = raw.replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new ExternalEnvironmentError(`${label} must be a safe relative path`, "EXTERNAL_ENV_PATH_INVALID", {
      path: raw,
    });
  }
  return normalized;
}

async function pathType(filePath, fsImpl = fs) {
  try {
    const stat = await fsImpl.lstat(filePath);
    if (stat.isSymbolicLink?.()) return "symlink";
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function hashFile(filePath, fsImpl = fs) {
  const stream = typeof fsImpl.createReadStream === "function"
    ? fsImpl.createReadStream(filePath)
    : createReadStream(filePath);
  const hash = createHash("sha256");
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function normalizePythonPath(root, pythonRelative, fsImpl) {
  const relative = normalizeSafeRelative(pythonRelative, "runtime pythonExecutable");
  const candidate = path.resolve(root, relative);
  if (!isWithin(root, candidate)) {
    throw new ExternalEnvironmentError("Python executable escapes the selected directory", "EXTERNAL_ENV_PATH_ESCAPE", {
      pythonExecutable: relative,
    });
  }
  if (await pathType(candidate, fsImpl) !== "file") {
    throw new ExternalEnvironmentError("Python executable is missing or is not a regular file", "EXTERNAL_ENV_PYTHON_MISSING", {
      pythonExecutable: relative,
    });
  }
  const pythonRealPath = await fsImpl.realpath(candidate);
  if (!isWithin(root, pythonRealPath)) {
    throw new ExternalEnvironmentError("Python executable resolves outside the selected directory", "EXTERNAL_ENV_PATH_ESCAPE", {
      pythonExecutable: relative,
    });
  }
  return { pythonExecutableRelative: relative, pythonExecutable: pythonRealPath };
}

function normalizeProcessResult(result) {
  if (!result || typeof result !== "object") return { success: false, code: 1, stdout: "", stderr: "empty process result" };
  const code = result.code ?? result.exitCode ?? (result.success === false ? 1 : 0);
  return {
    ...result,
    success: result.success !== false && Number(code) === 0,
    code: Number.isFinite(Number(code)) ? Number(code) : 1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

async function defaultRunner(command, args, options) {
  try {
    return normalizeProcessResult(await runStartupProcess(command, args, {
      ...options,
      timeoutMs: options.timeoutMs || DEFAULT_EXTERNAL_PROBE_TIMEOUT_MS,
      spawnOptions: { windowsHide: true, ...(options.spawnOptions || {}) },
    }));
  } catch (error) {
    const diagnostic = error?.diagnostic || {};
    return normalizeProcessResult({
      success: false,
      code: diagnostic.exitCode ?? error?.code ?? 1,
      stdout: diagnostic.stdout,
      stderr: diagnostic.stderr || error?.message,
      error,
    });
  }
}

async function invokeRunner(runner, command, args, options) {
  try {
    if (typeof runner === "function") return normalizeProcessResult(await runner(command, args, options));
    if (runner && typeof runner.run === "function") return normalizeProcessResult(await runner.run(command, args, options));
    return await defaultRunner(command, args, options);
  } catch (error) {
    return normalizeProcessResult({ success: false, code: error?.code || 1, stderr: error?.message || String(error), error });
  }
}

function parseJsonOutput(result, code, label) {
  const lines = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line.trim());
      if (isPlainObject(value)) return value;
    } catch {
      // Native packages can emit warnings before the final JSON line.
    }
  }
  throw new ExternalEnvironmentError(`${label} did not return valid JSON`, code, {
    stdout: result.stdout.slice(-1_000),
    stderr: result.stderr.slice(-1_000),
  });
}

function commandFailure(result, message, code, details = {}) {
  if (result.success) return;
  throw new ExternalEnvironmentError(message, code, {
    ...details,
    exitCode: result.code,
    stderr: result.stderr.slice(-1_000),
  });
}

function expectedAcceleratorFromManifest(manifest) {
  const value = String(manifest?.runtimeFlavor || manifest?.accelerator || "").trim().toLowerCase();
  return value === "cpu" || value === "cu130" ? value : null;
}

function makeFingerprintPayload(layout) {
  return {
    normalizedPath: layout.normalizedPath,
    layout: layout.layout,
    pythonExecutableRelative: layout.pythonExecutableRelative,
    pythonSha256: layout.pythonSha256,
    runtimeManifestSha256: layout.runtimeManifestSha256 || null,
    markerSha256: layout.markerSha256 || null,
  };
}

export async function resolveExternalEnvironmentLayout(directoryPath, {
  fsImpl = fs,
  platform = process.platform,
} = {}) {
  const selectedPath = String(directoryPath ?? "").trim();
  if (!selectedPath || !path.isAbsolute(selectedPath)) {
    throw new ExternalEnvironmentError("Select an absolute environment directory", "EXTERNAL_ENV_DIRECTORY_INVALID");
  }
  if (await pathType(selectedPath, fsImpl) !== "directory") {
    throw new ExternalEnvironmentError("Selected environment directory does not exist", "EXTERNAL_ENV_DIRECTORY_INVALID");
  }
  const normalizedPath = await fsImpl.realpath(selectedPath);
  const manifestPath = path.join(normalizedPath, "runtime-manifest.json");
  const manifestType = await pathType(manifestPath, fsImpl);
  let layout;
  let manifest = null;
  let manifestBytes = null;
  let markerPath = null;
  let pythonRelative;

  if (manifestType === "file") {
    manifestBytes = await fsImpl.readFile(manifestPath);
    try {
      manifest = JSON.parse(manifestBytes.toString("utf8"));
    } catch (error) {
      throw new ExternalEnvironmentError(`runtime-manifest.json is invalid: ${error.message}`, "EXTERNAL_ENV_MANIFEST_INVALID");
    }
    if (!isPlainObject(manifest)) {
      throw new ExternalEnvironmentError("runtime-manifest.json must be an object", "EXTERNAL_ENV_MANIFEST_INVALID");
    }
    layout = EXTERNAL_ENVIRONMENT_LAYOUTS.RUNTIME_MANIFEST;
    pythonRelative = manifest.pythonExecutable;
  } else if (manifestType === "symlink") {
    throw new ExternalEnvironmentError("runtime-manifest.json must not be a symbolic link", "EXTERNAL_ENV_PATH_ESCAPE");
  } else if (await pathType(path.join(normalizedPath, platform === "win32" ? "python.exe" : "python"), fsImpl) === "file") {
    layout = EXTERNAL_ENVIRONMENT_LAYOUTS.CONDA;
    pythonRelative = platform === "win32" ? "python.exe" : "python";
  } else {
    const venvPython = platform === "win32" ? "Scripts/python.exe" : "bin/python";
    markerPath = path.join(normalizedPath, "pyvenv.cfg");
    if (
      await pathType(path.resolve(normalizedPath, venvPython), fsImpl) !== "file" ||
      await pathType(markerPath, fsImpl) !== "file"
    ) {
      throw new ExternalEnvironmentError(
        "Selected directory is not a supported runtime-manifest, conda, or venv root",
        "EXTERNAL_ENV_LAYOUT_UNSUPPORTED",
      );
    }
    layout = EXTERNAL_ENVIRONMENT_LAYOUTS.VENV;
    pythonRelative = venvPython;
  }

  const python = await normalizePythonPath(normalizedPath, pythonRelative, fsImpl);
  const pythonSha256 = await hashFile(python.pythonExecutable, fsImpl);
  const runtimeManifestSha256 = manifestBytes ? createHash("sha256").update(manifestBytes).digest("hex") : null;
  const markerSha256 = markerPath ? await hashFile(markerPath, fsImpl) : null;
  const resolved = {
    selectedPath: path.resolve(selectedPath),
    normalizedPath,
    layout,
    ...python,
    manifest,
    expectedAccelerator: expectedAcceleratorFromManifest(manifest),
    pythonSha256,
    runtimeManifestSha256,
    markerSha256,
  };
  resolved.fingerprint = createHash("sha256")
    .update(JSON.stringify(makeFingerprintPayload(resolved)))
    .digest("hex");
  return resolved;
}

export async function probeExternalEnvironment({
  directoryPath,
  backendProjectPath,
  ffmpegPath,
  runner,
  fsImpl = fs,
  platform = process.platform,
  baseEnv = process.env,
  timeoutMs = DEFAULT_EXTERNAL_PROBE_TIMEOUT_MS,
  signal,
} = {}) {
  const layout = await resolveExternalEnvironmentLayout(directoryPath, { fsImpl, platform });
  if (
    !backendProjectPath ||
    !path.isAbsolute(backendProjectPath) ||
    await pathType(backendProjectPath, fsImpl) !== "directory"
  ) {
    throw new ExternalEnvironmentError("Bundled backend path is unavailable", "EXTERNAL_ENV_BACKEND_PATH_INVALID");
  }
  if (!ffmpegPath || !path.isAbsolute(ffmpegPath) || await pathType(ffmpegPath, fsImpl) !== "file") {
    throw new ExternalEnvironmentError("Bundled FFmpeg is unavailable", "EXTERNAL_ENV_FFMPEG_UNAVAILABLE");
  }
  const isolatedEnv = createIsolatedPythonEnv({
    baseEnv,
    envRoot: layout.normalizedPath,
    platform,
    overrides: {
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      PIP_NO_CACHE_DIR: "1",
    },
  });
  isolatedEnv.PYTHONPATH = path.resolve(backendProjectPath);
  const run = (command, args, stage, env = isolatedEnv) => invokeRunner(runner, command, args, {
    cwd: layout.normalizedPath,
    env,
    signal,
    timeoutMs,
    stage,
  });

  const pythonResult = await run(layout.pythonExecutable, ["-c", PYTHON_IDENTITY_SCRIPT], "external-environment-python");
  commandFailure(pythonResult, "External Python could not be inspected", "EXTERNAL_ENV_PYTHON_UNAVAILABLE");
  const python = parseJsonOutput(pythonResult, "EXTERNAL_ENV_PYTHON_UNAVAILABLE", "External Python");
  const versionMatch = String(python.version || "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (python.implementation !== "CPython" || !versionMatch || Number(versionMatch[1]) !== 3 || Number(versionMatch[2]) !== 12) {
    throw new ExternalEnvironmentError(
      `External environment requires 64-bit CPython 3.12.x; found ${python.implementation || "unknown"} ${python.version || "unknown"}`,
      "EXTERNAL_ENV_PYTHON_VERSION_UNSUPPORTED",
      { implementation: python.implementation || null, version: python.version || null },
    );
  }
  if (Number(python.bits) !== 64) {
    throw new ExternalEnvironmentError("External Python must be 64-bit", "EXTERNAL_ENV_ARCH_UNSUPPORTED", { bits: python.bits });
  }
  if (python.executable) {
    let reportedRealPath;
    try {
      reportedRealPath = await fsImpl.realpath(String(python.executable));
    } catch {
      throw new ExternalEnvironmentError("Python reported an invalid executable path", "EXTERNAL_ENV_CHANGED_AFTER_PROBE");
    }
    if (reportedRealPath !== layout.pythonExecutable || !isWithin(layout.normalizedPath, reportedRealPath)) {
      throw new ExternalEnvironmentError("Python executable changed during inspection", "EXTERNAL_ENV_CHANGED_AFTER_PROBE", {
        expected: layout.pythonExecutable,
        actual: reportedRealPath,
      });
    }
  }

  const torchResult = await run(layout.pythonExecutable, ["-c", TORCH_IDENTITY_SCRIPT], "external-environment-torch");
  commandFailure(torchResult, "PyTorch is unavailable in the external environment", "EXTERNAL_ENV_TORCH_UNAVAILABLE");
  const torch = parseJsonOutput(torchResult, "EXTERNAL_ENV_TORCH_UNAVAILABLE", "PyTorch");
  const accelerator = torch.cudaAvailable ? "cu130" : "cpu";
  if (accelerator === "cu130" && (!String(torch.cudaVersion || "").startsWith("13.") || Number(torch.deviceCount) < 1)) {
    throw new ExternalEnvironmentError("External CUDA environment is not compatible with cu130", "EXTERNAL_ENV_CUDA_UNAVAILABLE", {
      cudaVersion: torch.cudaVersion || null,
      deviceCount: Number(torch.deviceCount) || 0,
    });
  }
  if (layout.expectedAccelerator === "cu130" && accelerator !== "cu130") {
    throw new ExternalEnvironmentError("The cu130 runtime cannot access a CUDA device", "EXTERNAL_ENV_CUDA_UNAVAILABLE");
  }
  if (layout.expectedAccelerator && layout.expectedAccelerator !== accelerator) {
    throw new ExternalEnvironmentError("Runtime accelerator does not match its manifest", "EXTERNAL_ENV_ACCELERATOR_MISMATCH", {
      expected: layout.expectedAccelerator,
      actual: accelerator,
    });
  }

  const pipResult = await run(layout.pythonExecutable, ["-m", "pip", "check"], "external-environment-pip-check");
  commandFailure(pipResult, "External environment dependencies are inconsistent", "EXTERNAL_ENV_DEPENDENCIES_BROKEN");

  const backendResult = await run(layout.pythonExecutable, ["-c", BACKEND_IMPORT_SCRIPT], "external-environment-backend");
  commandFailure(backendResult, "Bundled backend cannot import with the external environment", "EXTERNAL_ENV_BACKEND_IMPORT_FAILED");

  const ffmpegResult = await run(path.resolve(ffmpegPath), ["-version"], "external-environment-ffmpeg", baseEnv);
  commandFailure(ffmpegResult, "Bundled FFmpeg health check failed", "EXTERNAL_ENV_FFMPEG_UNAVAILABLE");

  const resolvedAfterProbe = await resolveExternalEnvironmentLayout(layout.normalizedPath, { fsImpl, platform });
  if (resolvedAfterProbe.fingerprint !== layout.fingerprint) {
    throw new ExternalEnvironmentError("External environment changed during the health check", "EXTERNAL_ENV_CHANGED_AFTER_PROBE");
  }
  return {
    success: true,
    environment: {
      selectedPath: layout.selectedPath,
      normalizedPath: layout.normalizedPath,
      layout: layout.layout,
      pythonExecutableRelative: layout.pythonExecutableRelative,
      pythonExecutable: layout.pythonExecutable,
      pythonVersion: String(python.version),
      pythonBits: Number(python.bits),
      torchVersion: String(torch.version || ""),
      cudaVersion: torch.cudaVersion ? String(torch.cudaVersion) : null,
      cudaAvailable: Boolean(torch.cudaAvailable),
      cudaDeviceCount: Number(torch.deviceCount) || 0,
      accelerator,
      fingerprint: layout.fingerprint,
      pythonSha256: layout.pythonSha256,
      runtimeManifestSha256: layout.runtimeManifestSha256,
    },
    diagnostics: {
      success: true,
      python: { ok: true, version: String(python.version), bits: Number(python.bits), executable: layout.pythonExecutable },
      torch: { ok: true, version: String(torch.version || "") },
      cuda: {
        ok: true,
        available: Boolean(torch.cudaAvailable),
        version: torch.cudaVersion ? String(torch.cudaVersion) : null,
        deviceCount: Number(torch.deviceCount) || 0,
      },
      dependencies: { ok: true },
      backend: { ok: true, module: "moonshine_server" },
      ffmpeg: {
        ok: true,
        path: path.resolve(ffmpegPath),
        version: String(ffmpegResult.stdout || ffmpegResult.stderr).trim().split(/\r?\n/, 1)[0] || "",
      },
      errors: [],
    },
  };
}

function validateConfig(value) {
  if (!isPlainObject(value) || value.schema !== EXTERNAL_ENVIRONMENT_SCHEMA || !isPlainObject(value.environment)) {
    throw new ExternalEnvironmentError("External environment configuration is invalid", "EXTERNAL_ENV_CONFIG_INVALID");
  }
  const environment = value.environment;
  if (!path.isAbsolute(String(environment.normalizedPath || "")) || !path.isAbsolute(String(environment.pythonExecutable || ""))) {
    throw new ExternalEnvironmentError("External environment configuration contains an invalid path", "EXTERNAL_ENV_CONFIG_INVALID");
  }
  return value;
}

export class ExternalEnvironmentService {
  constructor({
    userData,
    configPath,
    backendProjectPath,
    ffmpegPath,
    runner,
    fsImpl = fs,
    platform = process.platform,
    baseEnv = process.env,
    now = Date.now,
    randomUUID = nodeRandomUUID,
    candidateTtlMs = DEFAULT_EXTERNAL_CANDIDATE_TTL_MS,
    probeTimeoutMs = DEFAULT_EXTERNAL_PROBE_TIMEOUT_MS,
  } = {}) {
    this.userData = path.resolve(String(userData || process.cwd()));
    this.configPath = configPath ? path.resolve(configPath) : path.join(this.userData, "environments", "external.json");
    this.backendProjectPath = backendProjectPath ? path.resolve(backendProjectPath) : "";
    this.ffmpegPath = ffmpegPath ? path.resolve(ffmpegPath) : "";
    this.runner = runner;
    this.fs = fsImpl;
    this.platform = platform;
    this.baseEnv = baseEnv;
    this.now = now;
    this.randomUUID = randomUUID;
    this.candidateTtlMs = Math.max(1_000, Number(candidateTtlMs) || DEFAULT_EXTERNAL_CANDIDATE_TTL_MS);
    this.probeTimeoutMs = Math.max(1_000, Number(probeTimeoutMs) || DEFAULT_EXTERNAL_PROBE_TIMEOUT_MS);
    this.candidates = new Map();
  }

  _pruneCandidates() {
    const current = Number(this.now());
    for (const [token, candidate] of this.candidates) {
      if (candidate.expiresAt <= current) this.candidates.delete(token);
    }
  }

  async _probe(directoryPath, signal) {
    return probeExternalEnvironment({
      directoryPath,
      backendProjectPath: this.backendProjectPath,
      ffmpegPath: this.ffmpegPath,
      runner: this.runner,
      fsImpl: this.fs,
      platform: this.platform,
      baseEnv: this.baseEnv,
      timeoutMs: this.probeTimeoutMs,
      signal,
    });
  }

  async probeDirectory({ directoryPath, signal } = {}) {
    this._pruneCandidates();
    try {
      const result = await this._probe(directoryPath, signal);
      const candidateToken = String(this.randomUUID());
      const candidateExpiresAt = Number(this.now()) + this.candidateTtlMs;
      this.candidates.set(candidateToken, {
        token: candidateToken,
        expiresAt: candidateExpiresAt,
        fingerprint: result.environment.fingerprint,
        directoryPath: result.environment.normalizedPath,
        result,
      });
      return {
        ...clone(result),
        candidateToken,
        candidateExpiresAt,
      };
    } catch (error) {
      return { success: false, ...normalizeError(error) };
    }
  }

  async activateCandidate({ candidateToken, signal } = {}) {
    this._pruneCandidates();
    const token = String(candidateToken || "");
    const candidate = this.candidates.get(token);
    if (!candidate) {
      return {
        success: false,
        code: "EXTERNAL_ENV_CANDIDATE_INVALID",
        message: "External environment candidate is missing or expired",
      };
    }
    this.candidates.delete(token);
    try {
      const reprobe = await this._probe(candidate.directoryPath, signal);
      if (reprobe.environment.fingerprint !== candidate.fingerprint) {
        throw new ExternalEnvironmentError("External environment changed after validation", "EXTERNAL_ENV_CHANGED_AFTER_PROBE");
      }
      const verifiedAt = new Date(this.now()).toISOString();
      const config = {
        schema: EXTERNAL_ENVIRONMENT_SCHEMA,
        selectedPath: candidate.result.environment.selectedPath,
        normalizedPath: reprobe.environment.normalizedPath,
        layout: reprobe.environment.layout,
        pythonExecutableRelative: reprobe.environment.pythonExecutableRelative,
        pythonExecutable: reprobe.environment.pythonExecutable,
        accelerator: reprobe.environment.accelerator,
        pythonVersion: reprobe.environment.pythonVersion,
        torchVersion: reprobe.environment.torchVersion,
        cudaVersion: reprobe.environment.cudaVersion,
        fingerprint: reprobe.environment.fingerprint,
        lastVerifiedAt: verifiedAt,
        environment: { ...reprobe.environment, lastVerifiedAt: verifiedAt },
      };
      await writeJsonAtomic(this.configPath, config);
      return { ...clone(reprobe), config: clone(config) };
    } catch (error) {
      return { success: false, ...normalizeError(error) };
    }
  }

  async loadConfig() {
    try {
      const value = JSON.parse(await this.fs.readFile(this.configPath, "utf8"));
      return { success: true, config: clone(validateConfig(value)) };
    } catch (error) {
      if (error?.code === "ENOENT") return { success: true, config: null };
      return { success: false, ...normalizeError(error, "EXTERNAL_ENV_CONFIG_INVALID") };
    }
  }

  async reprobeConfigured({ signal } = {}) {
    const loaded = await this.loadConfig();
    if (!loaded.success || !loaded.config) return loaded;
    try {
      const result = await this._probe(loaded.config.environment.normalizedPath, signal);
      if (result.environment.fingerprint !== loaded.config.environment.fingerprint) {
        throw new ExternalEnvironmentError("External environment changed since activation", "EXTERNAL_ENV_CHANGED_AFTER_PROBE");
      }
      const verifiedAt = new Date(this.now()).toISOString();
      const config = {
        ...loaded.config,
        normalizedPath: result.environment.normalizedPath,
        pythonExecutable: result.environment.pythonExecutable,
        fingerprint: result.environment.fingerprint,
        lastVerifiedAt: verifiedAt,
        environment: { ...result.environment, lastVerifiedAt: verifiedAt },
      };
      await writeJsonAtomic(this.configPath, config);
      return { ...clone(result), config: clone(config) };
    } catch (error) {
      return { success: false, ...normalizeError(error), config: loaded.config };
    }
  }

  async forget() {
    this.candidates.clear();
    await this.fs.rm(this.configPath, { force: true });
    return { success: true };
  }
}

export {
  BACKEND_IMPORT_SCRIPT,
  PYTHON_IDENTITY_SCRIPT,
  TORCH_IDENTITY_SCRIPT,
  defaultRunner,
};
