import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runStartupProcess } from "../startup-process.js";
import { detectAccelerator } from "./environment-detector.js";
import {
  DEFAULT_PYTHON_VERSION,
  buildEnvironmentSpec,
  verifyEnvironmentSpecHash,
  normalizeAcceleratorPreference,
} from "./environment-spec.js";
import { probeEnvironment } from "./environment-probe.js";
import { canonicalizeJson } from "./manifest-verifier.js";

export const ENVIRONMENT_BOOTSTRAP_SCHEMA = 1;
export const DEFAULT_PYTHON_INSTALLER_URL =
  "https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe";
export const DEFAULT_PYPI_INDEX_URL = "https://pypi.org/simple";
export const DEFAULT_TORCH_INDEX_URLS = Object.freeze({
  cpu: "https://download.pytorch.org/whl/cpu",
  cu130: "https://download.pytorch.org/whl/cu130",
});

const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const OFFLINE_PAYLOAD_SCHEMA = 1;
const OFFLINE_PAYLOAD_VARIANTS = Object.freeze(["cpu", "cu130"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeOfflineVariant(value) {
  const variant = String(value ?? "").trim().toLowerCase();
  if (!OFFLINE_PAYLOAD_VARIANTS.includes(variant)) {
    throw new EnvironmentBootstrapError(
      `Unsupported offline payload variant: ${variant || "missing"}`,
      "ENVIRONMENT_PAYLOAD_VARIANT_INVALID",
    );
  }
  return variant;
}

function normalizeOfflineRelativePath(value, label = "payload file path") {
  const raw = String(value ?? "").trim();
  const normalized = raw.replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new EnvironmentBootstrapError(`${label} is not a safe relative path`, "ENVIRONMENT_PAYLOAD_PATH_INVALID", {
      path: raw,
    });
  }
  return normalized;
}

function resolvePayloadPath(root, relative, label = "payload file path") {
  const payloadRoot = path.resolve(root);
  const normalized = normalizeOfflineRelativePath(relative, label);
  const target = path.resolve(payloadRoot, normalized);
  const outside = path.relative(payloadRoot, target);
  if (outside === ".." || outside.startsWith(`..${path.sep}`) || path.isAbsolute(outside)) {
    throw new EnvironmentBootstrapError(`${label} escapes the payload root`, "ENVIRONMENT_PAYLOAD_PATH_INVALID", {
      path: relative,
    });
  }
  return { normalized, path: target };
}

function payloadDestinationPath(stagingPath, relative, label) {
  const normalized = normalizeOfflineRelativePath(relative, label);
  const prefix = normalized.split("/", 1)[0];
  if (!["runtime", "ffmpeg", "models"].includes(prefix)) {
    throw new EnvironmentBootstrapError(
      `Offline payload file must be under runtime, ffmpeg, or models: ${normalized}`,
      "ENVIRONMENT_PAYLOAD_PATH_INVALID",
    );
  }
  if (prefix === "models") return null;
  const remainder = normalized.slice(prefix.length + 1);
  if (!remainder) {
    throw new EnvironmentBootstrapError(`Offline payload entry is not a file: ${normalized}`, "ENVIRONMENT_PAYLOAD_FILE_INVALID");
  }
  return path.resolve(stagingPath, prefix === "runtime" ? remainder : path.join("ffmpeg", remainder));
}

export const BOOTSTRAP_STATUS = Object.freeze({
  IDLE: "idle",
  STAGING: "staging",
  BOOTSTRAPPING: "bootstrapping",
  PROBING: "probing",
  READY: "ready",
  FAILED: "failed",
  ROLLING_BACK: "rolling-back",
});

export class EnvironmentBootstrapError extends Error {
  constructor(message, code = "ENVIRONMENT_BOOTSTRAP_FAILED", details = {}) {
    super(message);
    this.name = "EnvironmentBootstrapError";
    this.code = code;
    this.details = details;
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function emitProgress(observer, payload) {
  if (typeof observer !== "function") return;
  try {
    observer(clone(payload));
  } catch {
    // Progress observers must not affect environment creation.
  }
}

function normalizeProcessResult(result) {
  if (!result || typeof result !== "object") {
    return { success: false, code: 1, stdout: "", stderr: "empty process result" };
  }
  const code = result.code ?? result.exitCode ?? (result.success === false ? 1 : 0);
  return {
    ...result,
    success: result.success !== false && Number(code) === 0,
    code: Number.isFinite(Number(code)) ? Number(code) : 1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function hashBuffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeHash(value, label) {
  const hash = String(value ?? "").trim().toLowerCase();
  if (!HASH_PATTERN.test(hash)) throw new EnvironmentBootstrapError(
    `${label} must be a 64-character SHA-256 hex string`,
    "ENVIRONMENT_HASH_INVALID",
  );
  return hash;
}

function resolvePlatformArch(platform, arch) {
  const normalizedPlatform = String(platform || process.platform).trim().toLowerCase();
  const normalizedArch = String(arch || process.arch).trim().toLowerCase();
  if (normalizedPlatform === "win32" && ["x64", "amd64"].includes(normalizedArch)) return "win-x64";
  return `${normalizedPlatform}-${normalizedArch}`;
}

function requiredPath(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new EnvironmentBootstrapError(`${label} is required`, "ENVIRONMENT_PATH_REQUIRED");
  return path.resolve(text);
}

function fileNameForFfmpeg(sourcePath, platform) {
  const name = path.basename(sourcePath || "");
  if (name) return name;
  return platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

function resolveInstallerPath(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    return value.path || value.pythonExecutable || value.executable || "";
  }
  return "";
}

function makeOperationId(now) {
  return `env-${Number(now())}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
}

async function defaultCommandRunner(command, args, options = {}) {
  try {
    const result = await runStartupProcess(command, args, {
      ...options,
      timeoutMs: options.timeoutMs || 30 * 60 * 1000,
      stage: options.stage || "environment-bootstrap",
      spawnOptions: { windowsHide: true, ...(options.spawnOptions || {}) },
    });
    return normalizeProcessResult(result);
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

async function invokeCommandRunner(runner, command, args, options) {
  if (typeof runner === "function") return normalizeProcessResult(await runner(command, args, options));
  if (runner && typeof runner.run === "function") {
    return normalizeProcessResult(await runner.run(command, args, options));
  }
  return defaultCommandRunner(command, args, options);
}

function mergeSources(base, overrides = {}, accelerator) {
  const merged = {
    pythonIndexUrl: base.pythonIndexUrl || DEFAULT_PYPI_INDEX_URL,
    pipIndexUrl: base.pipIndexUrl || base.pythonIndexUrl || DEFAULT_PYPI_INDEX_URL,
    torchIndexUrl: base.torchIndexUrl || DEFAULT_TORCH_INDEX_URLS[accelerator],
    extraIndexUrl: base.extraIndexUrl || "",
    pythonInstallerUrl: base.pythonInstallerUrl || DEFAULT_PYTHON_INSTALLER_URL,
    ...overrides,
  };
  if (!merged.pipIndexUrl) merged.pipIndexUrl = merged.pythonIndexUrl;
  if (!merged.torchIndexUrl) merged.torchIndexUrl = DEFAULT_TORCH_INDEX_URLS[accelerator];
  return merged;
}

function serializeError(error) {
  return {
    message: error?.message || String(error),
    code: error?.code || "ENVIRONMENT_BOOTSTRAP_FAILED",
    details: clone(error?.details || {}),
  };
}

export class EnvironmentBootstrap {
  constructor({
    rootDir,
    appVersion,
    pythonVersion = DEFAULT_PYTHON_VERSION,
    platform = process.platform,
    arch = process.arch,
    requirementsLockPath,
    requirementsPath = requirementsLockPath,
    requirementsPaths = {},
    requirementsLockPaths = requirementsPaths,
    requirementsLockHash,
    requirementsLockHashes = {},
    ffmpegSourcePath,
    ffmpegHash,
    pythonExecutable = "python",
    pythonInstaller,
    commandRunner,
    acceleratorRunner,
    sourceConfig = {},
    probe = probeEnvironment,
    detector = detectAccelerator,
    fsImpl = fs,
    now = Date.now,
    baseEnv = process.env,
    minimumDriverMajor,
    publicKeys = {},
    expectedKeyId = "moonshine-app-manifest-v1",
    requireSignedPayload = false,
    timeoutMs = 30 * 60 * 1000,
  } = {}) {
    this.rootDir = requiredPath(rootDir || path.join(os.tmpdir(), "Moonshine-Image"), "rootDir");
    this.appVersion = String(appVersion ?? "").trim();
    if (!this.appVersion) throw new EnvironmentBootstrapError("appVersion is required", "ENVIRONMENT_APP_VERSION_REQUIRED");
    this.pythonVersion = String(pythonVersion || DEFAULT_PYTHON_VERSION).trim();
    this.platform = String(platform || process.platform);
    this.arch = String(arch || process.arch);
    this.platformArch = resolvePlatformArch(this.platform, this.arch);
    this.requirementsLockPath = requirementsLockPath || requirementsPath || "";
    this.requirementsPath = requirementsPath || requirementsLockPath || "";
    this.requirementsPaths = { ...requirementsPaths };
    this.requirementsLockPaths = { ...requirementsLockPaths };
    this.requirementsLockHash = requirementsLockHash || "";
    this.requirementsLockHashes = { ...requirementsLockHashes };
    this.ffmpegSourcePath = ffmpegSourcePath || "";
    this.ffmpegHash = ffmpegHash || "";
    this.pythonExecutable = pythonExecutable || "python";
    this.pythonInstaller = pythonInstaller;
    this.commandRunner = commandRunner;
    this.acceleratorRunner = acceleratorRunner;
    this.sourceConfig = { ...sourceConfig };
    this.probe = probe;
    this.detector = detector;
    this.fs = fsImpl;
    this.now = now;
    this.baseEnv = baseEnv;
    this.minimumDriverMajor = minimumDriverMajor;
    this.publicKeys = publicKeys;
    this.expectedKeyId = String(expectedKeyId || "moonshine-app-manifest-v1").trim();
    this.requireSignedPayload = Boolean(requireSignedPayload);
    this.timeoutMs = timeoutMs;

    this.environmentsRoot = path.join(this.rootDir, "environments", this.platformArch);
    this.activePointerPath = path.join(this.rootDir, "environments", "active.json");
    this.historyPath = path.join(this.rootDir, "environments", "history.json");
    this.stagingRoot = path.join(this.rootDir, "environments", ".staging");
    this.state = {
      status: BOOTSTRAP_STATUS.IDLE,
      selectedAccelerator: null,
      selectionReason: null,
      operationId: null,
      stagingPath: null,
      activePath: null,
      specHash: null,
      error: null,
      steps: [],
      startedAt: null,
      finishedAt: null,
    };
  }

  getState() {
    return clone(this.state);
  }

  async _readJson(filePath, defaultValue = null) {
    try {
      return JSON.parse(await this.fs.readFile(filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return defaultValue;
      throw error;
    }
  }

  async _writeJsonAtomic(filePath, value, operationId = "write") {
    await this.fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp-${operationId}-${process.pid}`;
    await this.fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      await this.fs.rename(tempPath, filePath);
    } catch (error) {
      await this.fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async _fileHash(filePath) {
    return hashBuffer(await this.fs.readFile(requiredPath(filePath, "filePath")));
  }

  async _streamFileDigest(filePath) {
    const target = requiredPath(filePath, "filePath");
    const stat = await this.fs.stat(target);
    if (!stat.isFile()) {
      throw new EnvironmentBootstrapError(`Payload entry is not a regular file: ${target}`, "ENVIRONMENT_PAYLOAD_FILE_INVALID");
    }
    const stream = typeof this.fs.createReadStream === "function"
      ? this.fs.createReadStream(target)
      : createReadStream(target);
    const digest = createHash("sha256");
    let size = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      digest.update(buffer);
    }
    return { size, sha256: digest.digest("hex") };
  }

  async _readOfflineManifest(payloadRoot, suppliedManifest) {
    if (suppliedManifest !== undefined && suppliedManifest !== null) {
      if (typeof suppliedManifest === "string") {
        const manifestPath = resolvePayloadPath(payloadRoot, suppliedManifest, "payload manifest path").path;
        return JSON.parse(await this.fs.readFile(manifestPath, "utf8"));
      }
      return suppliedManifest;
    }
    const manifestPath = path.join(payloadRoot, "payload-manifest.json");
    try {
      return JSON.parse(await this.fs.readFile(manifestPath, "utf8"));
    } catch (error) {
      throw new EnvironmentBootstrapError(
        `Offline payload manifest is invalid: ${error.message}`,
        "ENVIRONMENT_PAYLOAD_MANIFEST_INVALID",
        { manifestPath },
      );
    }
  }

  async _verifyOfflineManifest(payloadRoot, suppliedManifest, accelerator) {
    const envelope = await this._readOfflineManifest(payloadRoot, suppliedManifest);
    if (!isPlainObject(envelope)) {
      throw new EnvironmentBootstrapError("Offline payload manifest must be an object", "ENVIRONMENT_PAYLOAD_MANIFEST_INVALID");
    }
    const signature = isPlainObject(envelope.signature) ? envelope.signature : null;
    const manifest = isPlainObject(envelope.payload)
      ? envelope.payload
      : Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== "signature"));
    if (!isPlainObject(manifest)) {
      throw new EnvironmentBootstrapError("Offline payload manifest payload must be an object", "ENVIRONMENT_PAYLOAD_MANIFEST_INVALID");
    }
    const publicKeyValue = this.publicKeys instanceof Map
      ? this.publicKeys.get(signature?.keyId || this.expectedKeyId)
      : this.publicKeys?.[signature?.keyId || this.expectedKeyId];
    if (this.requireSignedPayload && !signature?.value) {
      throw new EnvironmentBootstrapError("Offline payload manifest signature is required", "ENVIRONMENT_PAYLOAD_SIGNATURE_REQUIRED");
    }
    if (signature?.value && publicKeyValue) {
      if (signature.algorithm !== "Ed25519" || signature.keyId !== this.expectedKeyId) {
        throw new EnvironmentBootstrapError("Offline payload manifest signature metadata is invalid", "ENVIRONMENT_PAYLOAD_SIGNATURE_INVALID");
      }
      let publicKey;
      try {
        publicKey = publicKeyValue.type === "public" || publicKeyValue.asymmetricKeyType
          ? publicKeyValue
          : createPublicKey(publicKeyValue);
      } catch (error) {
        throw new EnvironmentBootstrapError(`Offline payload public key is invalid: ${error.message}`, "ENVIRONMENT_PAYLOAD_SIGNATURE_INVALID");
      }
      const signatureBytes = Buffer.from(String(signature.value), "base64");
      if (signatureBytes.length !== 64 || !verifySignature(null, canonicalizeJson(manifest), publicKey, signatureBytes)) {
        throw new EnvironmentBootstrapError("Offline payload manifest signature verification failed", "ENVIRONMENT_PAYLOAD_SIGNATURE_INVALID");
      }
    } else if (this.requireSignedPayload) {
      throw new EnvironmentBootstrapError("Offline payload manifest has no trusted signing key", "ENVIRONMENT_PAYLOAD_SIGNATURE_INVALID");
    }
    const schema = manifest.schema ?? manifest.schemaVersion;
    if (schema !== OFFLINE_PAYLOAD_SCHEMA) {
      throw new EnvironmentBootstrapError("Offline payload manifest schema is unsupported", "ENVIRONMENT_PAYLOAD_SCHEMA_UNSUPPORTED", {
        schema,
      });
    }
    const manifestAppVersion = String(manifest.appVersion ?? manifest.version ?? "").trim();
    if (!manifestAppVersion || manifestAppVersion !== this.appVersion) {
      throw new EnvironmentBootstrapError(
        `Offline payload app version does not match ${this.appVersion}`,
        "ENVIRONMENT_PAYLOAD_VERSION_MISMATCH",
        { expected: this.appVersion, actual: manifestAppVersion || null },
      );
    }
    const variant = normalizeOfflineVariant(manifest.variant);
    const preference = normalizeAcceleratorPreference(accelerator);
    if (preference !== "auto" && preference !== variant) {
      throw new EnvironmentBootstrapError(
        `Offline payload variant ${variant} does not match ${preference}`,
        "ENVIRONMENT_PAYLOAD_VARIANT_MISMATCH",
        { expected: preference, actual: variant },
      );
    }
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
      throw new EnvironmentBootstrapError("Offline payload manifest files are required", "ENVIRONMENT_PAYLOAD_FILES_REQUIRED");
    }

    const seen = new Set();
    const entries = [];
    for (const [index, file] of manifest.files.entries()) {
      if (!isPlainObject(file)) {
        throw new EnvironmentBootstrapError(`Offline payload files[${index}] must be an object`, "ENVIRONMENT_PAYLOAD_FILE_INVALID");
      }
      const relative = normalizeOfflineRelativePath(file.path, `payload files[${index}].path`);
      const identity = this.platform === "win32" ? relative.toLowerCase() : relative;
      if (seen.has(identity)) {
        throw new EnvironmentBootstrapError(`Duplicate offline payload file: ${relative}`, "ENVIRONMENT_PAYLOAD_FILE_DUPLICATE");
      }
      seen.add(identity);
      if (!Number.isSafeInteger(file.size) || file.size < 0) {
        throw new EnvironmentBootstrapError(`Invalid size for offline payload file: ${relative}`, "ENVIRONMENT_PAYLOAD_FILE_INVALID");
      }
      const expectedHash = normalizeHash(file.sha256, `payload files[${index}].sha256`);
      const resolved = resolvePayloadPath(payloadRoot, relative);
      const stat = await this.fs.lstat(resolved.path);
      if (stat.isSymbolicLink?.()) {
        throw new EnvironmentBootstrapError(`Offline payload symlink is not allowed: ${relative}`, "ENVIRONMENT_PAYLOAD_SYMLINK_FORBIDDEN");
      }
      const digest = await this._streamFileDigest(resolved.path);
      if (digest.size !== file.size || digest.sha256 !== expectedHash) {
        throw new EnvironmentBootstrapError(`Offline payload hash mismatch: ${relative}`, "ENVIRONMENT_PAYLOAD_HASH_MISMATCH", {
          path: relative,
          expectedSize: file.size,
          actualSize: digest.size,
          expectedHash,
          actualHash: digest.sha256,
        });
      }
      entries.push({ ...file, path: relative, sha256: expectedHash, sourcePath: resolved.path, digest });
    }
    const hasRuntime = entries.some(({ path: relative }) => relative.startsWith("runtime/"));
    const hasFfmpeg = entries.some(({ path: relative }) => relative.startsWith("ffmpeg/"));
    if (!hasRuntime) throw new EnvironmentBootstrapError("Offline payload runtime files are required", "ENVIRONMENT_PAYLOAD_RUNTIME_MISSING");
    if (!hasFfmpeg) throw new EnvironmentBootstrapError("Offline payload FFmpeg files are required", "ENVIRONMENT_PAYLOAD_FFMPEG_MISSING");
    const specHash = manifest.specHash ? normalizeHash(manifest.specHash, "payload specHash") : null;
    return {
      manifest,
      variant,
      preference,
      selectedAccelerator: variant,
      selection: {
        preference,
        selectedAccelerator: variant,
        reason: preference === "auto" ? "offline-payload-variant" : "manual-offline-payload",
        nvidia: { skipped: true, available: false, compatible: variant === "cu130" },
      },
      entries,
      specHash,
    };
  }

  async _offlineSpec({ manifest, variant, specHash, entries }) {
    const supplied = manifest.environmentSpec || manifest.spec;
    let spec;
    if (supplied !== undefined) {
      if (!isPlainObject(supplied)) {
        throw new EnvironmentBootstrapError("Offline environmentSpec must be an object", "ENVIRONMENT_PAYLOAD_SPEC_INVALID");
      }
      spec = buildEnvironmentSpec({
        ...supplied,
        appVersion: this.appVersion,
        accelerator: variant,
      });
    } else {
      const requirementsEntry = entries.find(({ path: relative }) => /(^|\/)requirements(?:[-_.]lock)?\.(?:txt|lock)$/i.test(relative));
      const ffmpegEntry = entries.find(({ path: relative }) => /(^|\/)(?:ffmpeg|ffmpeg\.exe)$/i.test(relative));
      const requirementsLockHash = normalizeHash(
        manifest.requirementsLockHash || requirementsEntry?.sha256,
        "requirementsLockHash",
      );
      const ffmpegHash = normalizeHash(manifest.ffmpegHash || ffmpegEntry?.sha256, "ffmpegHash");
      spec = buildEnvironmentSpec({
        appVersion: this.appVersion,
        pythonVersion: manifest.pythonVersion || this.pythonVersion,
        accelerator: variant,
        requirementsLockHash,
        ffmpegHash,
      });
    }
    if (!verifyEnvironmentSpecHash(spec)) {
      throw new EnvironmentBootstrapError("Offline environment spec hash is invalid", "ENVIRONMENT_PAYLOAD_SPEC_INVALID");
    }
    if (specHash && spec.specHash !== specHash) {
      throw new EnvironmentBootstrapError("Offline payload specHash does not match environmentSpec", "ENVIRONMENT_PAYLOAD_SPEC_HASH_MISMATCH", {
        expected: specHash,
        actual: spec.specHash,
      });
    }
    return spec;
  }

  async _copyOfflineEntries(stagingPath, entries) {
    const copied = [];
    for (const entry of entries) {
      const target = payloadDestinationPath(stagingPath, entry.path, "payload file path");
      if (!target) continue;
      const root = path.resolve(stagingPath);
      const outside = path.relative(root, target);
      if (outside === ".." || outside.startsWith(`..${path.sep}`) || path.isAbsolute(outside)) {
        throw new EnvironmentBootstrapError(`Offline payload destination escapes staging: ${entry.path}`, "ENVIRONMENT_PAYLOAD_PATH_INVALID");
      }
      await this.fs.mkdir(path.dirname(target), { recursive: true });
      await this.fs.copyFile(entry.sourcePath, target);
      copied.push({ sourcePath: entry.sourcePath, targetPath: target, path: entry.path });
    }
    return copied;
  }

  async _offlineRuntimePaths(stagingPath, entries) {
    const pythonCandidates = this.platform === "win32"
      ? [
        path.join(stagingPath, "venv", "Scripts", "python.exe"),
        path.join(stagingPath, "venv", "python.exe"),
        path.join(stagingPath, "env", "python.exe"),
        path.join(stagingPath, "env", "Scripts", "python.exe"),
      ]
      : [
        path.join(stagingPath, "venv", "bin", "python"),
        path.join(stagingPath, "venv", "python"),
        path.join(stagingPath, "env", "bin", "python"),
        path.join(stagingPath, "env", "python"),
      ];
    let pythonExecutable = null;
    for (const candidate of pythonCandidates) {
      if (await this.fs.stat(candidate).then((value) => value.isFile()).catch(() => false)) {
        pythonExecutable = candidate;
        break;
      }
    }
    if (!pythonExecutable) {
      throw new EnvironmentBootstrapError("Offline payload must contain a prebuilt venv Python executable", "ENVIRONMENT_PAYLOAD_VENV_MISSING");
    }
    const condaUnpackCandidates = this.platform === "win32"
      ? [
        path.join(stagingPath, "env", "Scripts", "conda-unpack.exe"),
        path.join(stagingPath, "venv", "Scripts", "conda-unpack.exe"),
      ]
      : [
        path.join(stagingPath, "env", "bin", "conda-unpack"),
        path.join(stagingPath, "venv", "bin", "conda-unpack"),
      ];
    let condaUnpackExecutable = null;
    for (const candidate of condaUnpackCandidates) {
      if (await this.fs.stat(candidate).then((value) => value.isFile()).catch(() => false)) {
        condaUnpackExecutable = candidate;
        break;
      }
    }
    const ffmpegEntry = entries.find(({ path: relative }) => /(^|\/)ffmpeg(?:\.exe)?$/i.test(relative));
    if (!ffmpegEntry) {
      throw new EnvironmentBootstrapError("Offline payload FFmpeg executable is missing", "ENVIRONMENT_PAYLOAD_FFMPEG_MISSING");
    }
    const ffmpegPath = payloadDestinationPath(stagingPath, ffmpegEntry.path, "payload FFmpeg path");
    return { pythonExecutable, ffmpegPath, condaUnpackExecutable };
  }

  async _resolveHash(value, filePath, label) {
    if (value) {
      const normalized = normalizeHash(value, label);
      if (filePath) {
        const actual = await this._fileHash(filePath);
        if (actual !== normalized) {
          throw new EnvironmentBootstrapError(
            `${label} does not match ${filePath}`,
            "ENVIRONMENT_HASH_MISMATCH",
            { expected: normalized, actual, filePath },
          );
        }
      }
      return normalized;
    }
    if (!filePath) {
      throw new EnvironmentBootstrapError(`${label} or source path is required`, "ENVIRONMENT_HASH_SOURCE_REQUIRED");
    }
    return this._fileHash(filePath);
  }

  async _activePointer() {
    const pointer = await this._readJson(this.activePointerPath);
    if (!pointer || typeof pointer !== "object") return null;
    const activePath = pointer.path ? path.resolve(this.rootDir, pointer.path) : "";
    if (!activePath || !activePath.startsWith(`${this.environmentsRoot}${path.sep}`)) return null;
    return { ...pointer, absolutePath: activePath };
  }

  async getActive() {
    return clone(await this._activePointer());
  }

  _setStatus(status, patch = {}) {
    this.state = { ...this.state, status, ...patch };
  }

  async _step(name, action) {
    const step = { name, status: "running", startedAt: this.now(), finishedAt: null, error: null };
    this.state.steps = [...this.state.steps, step];
    try {
      const value = await action();
      step.status = "complete";
      step.finishedAt = this.now();
      return value;
    } catch (error) {
      step.status = "failed";
      step.finishedAt = this.now();
      step.error = serializeError(error);
      throw error;
    }
  }

  async _run(command, args, label, signal) {
    const result = await invokeCommandRunner(this.commandRunner, command, args, {
      cwd: this.state.stagingPath || this.rootDir,
      env: this.baseEnv,
      signal,
      timeoutMs: this.timeoutMs,
      stage: `environment-bootstrap-${label}`,
    });
    const record = { label, command, args: [...args], code: result.code, stdout: result.stdout, stderr: result.stderr };
    const lastStep = this.state.steps.at(-1);
    if (lastStep) lastStep.command = record;
    if (!result.success) {
      throw new EnvironmentBootstrapError(
        `${label} failed${result.stderr ? `: ${result.stderr.trim().split(/\r?\n/, 1)[0]}` : ""}`,
        "ENVIRONMENT_COMMAND_FAILED",
        { label, command, args, result: record },
      );
    }
    return result;
  }

  async _discoverPython(signal, sources = this.sourceConfig, onProgress) {
    const configured = this.pythonExecutable;
    const candidates = Array.isArray(configured) ? configured : [configured];
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const result = await invokeCommandRunner(this.commandRunner, candidate, ["--version"], {
          cwd: this.rootDir,
          env: this.baseEnv,
          signal,
          timeoutMs: Math.min(this.timeoutMs, 30_000),
          stage: "environment-bootstrap-python-discover",
        });
        if (result.success) return String(candidate);
      } catch {
        // Continue to the next candidate or the injected Python installer.
      }
    }
    if (typeof this.pythonInstaller === "function") {
      const installed = await this.pythonInstaller({
        version: this.pythonVersion,
        url: sources.pythonInstallerUrl || DEFAULT_PYTHON_INSTALLER_URL,
        rootDir: this.rootDir,
        signal,
        onProgress,
      });
      const installedPath = resolveInstallerPath(installed);
      if (installedPath) return String(installedPath);
    } else if (this.pythonInstaller && typeof this.pythonInstaller.install === "function") {
      const installed = await this.pythonInstaller.install({
        version: this.pythonVersion,
        url: sources.pythonInstallerUrl || DEFAULT_PYTHON_INSTALLER_URL,
        rootDir: this.rootDir,
        signal,
        onProgress,
      });
      const installedPath = resolveInstallerPath(installed);
      if (installedPath) return String(installedPath);
    }
    throw new EnvironmentBootstrapError(
      "No supported Python interpreter was found and no installer was provided",
      "ENVIRONMENT_PYTHON_NOT_FOUND",
    );
  }

  async _copyFfmpeg(stagingPath, expectedHash = "") {
    if (!this.ffmpegSourcePath) {
      throw new EnvironmentBootstrapError("ffmpegSourcePath is required", "ENVIRONMENT_FFMPEG_SOURCE_REQUIRED");
    }
    const source = requiredPath(this.ffmpegSourcePath, "ffmpegSourcePath");
    const target = path.join(stagingPath, "ffmpeg", fileNameForFfmpeg(source, this.platform));
    await this.fs.mkdir(path.dirname(target), { recursive: true });
    await this.fs.copyFile(source, target);
    const hash = await this._fileHash(target);
    if (expectedHash && hash !== expectedHash) {
      throw new EnvironmentBootstrapError(
        `FFmpeg hash does not match ${source}`,
        "ENVIRONMENT_HASH_MISMATCH",
        { expected: expectedHash, actual: hash, filePath: source },
      );
    }
    return { path: target, hash };
  }

  _sourceConfig(accelerator, sourceOverrides) {
    return mergeSources(
      { ...this.sourceConfig },
      sourceOverrides || {},
      accelerator,
    );
  }

  _requirementsFor(accelerator) {
    const selected = normalizeAcceleratorPreference(accelerator);
    const requirementsPath = this.requirementsPaths[selected] || this.requirementsPath;
    const requirementsLockPath = this.requirementsLockPaths[selected] || this.requirementsLockPath || requirementsPath;
    const requirementsLockHash = this.requirementsLockHashes[selected] || this.requirementsLockHash;
    return { requirementsPath, requirementsLockPath, requirementsLockHash };
  }

  async _activate(stagingPath, targetPath, pointer, operationId, previous) {
    let displacedPath = null;
    const targetExists = await this.fs.stat(targetPath).then(() => true).catch(() => false);
    if (targetExists) {
      if (previous?.absolutePath && path.resolve(previous.absolutePath) === path.resolve(targetPath)) {
        displacedPath = `${targetPath}.previous-${operationId}`;
        await this.fs.rename(targetPath, displacedPath);
      } else {
        await this.fs.rm(targetPath, { recursive: true, force: true });
      }
    }
    try {
      await this.fs.mkdir(path.dirname(targetPath), { recursive: true });
      await this.fs.rename(stagingPath, targetPath);
      await this._writeJsonAtomic(this.activePointerPath, pointer, operationId);
    } catch (error) {
      await this.fs.rm(targetPath, { recursive: true, force: true }).catch(() => {});
      if (displacedPath) await this.fs.rename(displacedPath, targetPath).catch(() => {});
      throw error;
    }
    if (displacedPath) await this.fs.rm(displacedPath, { recursive: true, force: true }).catch(() => {});
  }

  async _appendHistory(pointer) {
    const history = await this._readJson(this.historyPath, []);
    const entries = Array.isArray(history) ? history : [];
    entries.push(pointer);
    await this._writeJsonAtomic(this.historyPath, entries.slice(-10), "history");
  }

  async check({ accelerator = "auto", signal } = {}) {
    const selection = await this.detector({
      preference: normalizeAcceleratorPreference(accelerator),
      runner: this.acceleratorRunner,
      minimumDriverMajor: this.minimumDriverMajor,
      signal,
    });
    const active = await this._activePointer();
    const sameAccelerator = active?.accelerator === selection.selectedAccelerator;
    const result = {
      success: true,
      selection,
      active: active ? clone(active) : null,
      ready: Boolean(active && sameAccelerator),
      selectedAccelerator: selection.selectedAccelerator,
    };
    this._setStatus(result.ready ? BOOTSTRAP_STATUS.READY : BOOTSTRAP_STATUS.IDLE, {
      selectedAccelerator: selection.selectedAccelerator,
      selectionReason: selection.reason || null,
      activePath: active?.absolutePath || null,
    });
    return result;
  }

  async bootstrap({ accelerator = "auto", force = false, sourceOverrides = {}, signal, onProgress } = {}) {
    const startedAt = this.now();
    const operationId = makeOperationId(this.now);
    let lastProgress = {
      phase: "preparing",
      status: "running",
      percent: 0,
      message: "正在准备运行环境。",
    };
    const reportProgress = (patch) => {
      lastProgress = { ...lastProgress, ...patch };
      emitProgress(onProgress, lastProgress);
    };
    this.state = {
      status: BOOTSTRAP_STATUS.STAGING,
      selectedAccelerator: null,
      selectionReason: null,
      operationId,
      stagingPath: null,
      activePath: (await this._activePointer())?.absolutePath || null,
      specHash: null,
      error: null,
      steps: [],
      startedAt,
      finishedAt: null,
    };
    reportProgress(lastProgress);
    let stagingPath = null;
    try {
      const preference = normalizeAcceleratorPreference(accelerator);
      const selection = await this._step("detect-accelerator", () => this.detector({
        preference,
        runner: this.acceleratorRunner,
        minimumDriverMajor: this.minimumDriverMajor,
        signal,
      }));
      const selectedAccelerator = selection.selectedAccelerator;
      this.state.selectedAccelerator = selectedAccelerator;
      this.state.selectionReason = selection.reason || null;
      reportProgress({
        phase: "detect-accelerator",
        percent: 5,
        message: selectedAccelerator === "cu130" ? "已选择 NVIDIA CUDA 环境。" : "已选择 CPU 环境。",
      });
      const sources = this._sourceConfig(selectedAccelerator, sourceOverrides);
      const requirements = this._requirementsFor(selectedAccelerator);
      const requirementsLockHash = await this._step("hash-requirements", () =>
        this._resolveHash(requirements.requirementsLockHash, requirements.requirementsLockPath, "requirementsLockHash"));
      const ffmpegHash = await this._step("hash-ffmpeg", () =>
        this._resolveHash(this.ffmpegHash, this.ffmpegSourcePath, "ffmpegHash"));
      const spec = buildEnvironmentSpec({
        appVersion: this.appVersion,
        pythonVersion: this.pythonVersion,
        accelerator: selectedAccelerator,
        requirementsLockHash,
        ffmpegHash,
      });
      this.state.specHash = spec.specHash;
      reportProgress({ phase: "resolve-environment", percent: 10, message: "正在检查可复用的运行环境。" });
      const previous = await this._activePointer();
      const targetPath = path.join(this.environmentsRoot, selectedAccelerator, spec.specHash);
      if (!force && previous?.specHash === spec.specHash && previous?.absolutePath === targetPath) {
        const activePython = previous?.pythonExecutableRelative
          ? path.resolve(targetPath, previous.pythonExecutableRelative)
          : path.join(
            targetPath,
            "venv",
            ...(this.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]),
          );
        const activeFfmpeg = previous?.ffmpegRelative
          ? path.resolve(targetPath, previous.ffmpegRelative)
          : path.join(targetPath, "ffmpeg", fileNameForFfmpeg(this.ffmpegSourcePath, this.platform));
        const healthy = await this._step("probe-active", () => this.probe({
          root: targetPath,
          pythonExecutable: activePython,
          ffmpegPath: activeFfmpeg,
          accelerator: selectedAccelerator,
          platform: this.platform,
          baseEnv: this.baseEnv,
        }));
        if (healthy?.success !== false) {
          this._setStatus(BOOTSTRAP_STATUS.READY, { activePath: targetPath, finishedAt: this.now() });
          reportProgress({ phase: "complete", status: "complete", percent: 100, message: "现有运行环境校验通过。" });
          return { success: true, created: false, reused: true, selection, spec, activePath: targetPath, state: this.getState() };
        }
      }

      stagingPath = path.join(this.stagingRoot, operationId);
      this.state.stagingPath = stagingPath;
      await this.fs.mkdir(stagingPath, { recursive: true });
      this._setStatus(BOOTSTRAP_STATUS.BOOTSTRAPPING);
      reportProgress({ phase: "python-discovery", percent: 12, message: "正在查找 Python 3.12 解释器。" });
      const python = await this._step("discover-python", () => this._discoverPython(
        signal,
        sources,
        (progress = {}) => {
          const downloadPercent = Number(progress.percent);
          const hasOperationPercent = progress.percent !== null && progress.percent !== undefined && Number.isFinite(downloadPercent);
          const percent = progress.phase === "python-download" && hasOperationPercent
            ? 12 + Math.round(Math.max(0, Math.min(100, downloadPercent)) * 0.18)
            : Math.max(12, Math.min(34, Number(progress.overallPercent || lastProgress.percent || 12)));
          reportProgress({
            ...progress,
            percent,
            operationPercent: hasOperationPercent ? downloadPercent : null,
          });
        },
      ));
      reportProgress({ phase: "python-ready", status: "running", percent: 35, message: "Python 解释器已就绪。" });
      const venvPath = path.join(stagingPath, "venv");
      reportProgress({ phase: "create-venv", percent: 40, message: "正在创建项目虚拟环境。" });
      await this._step("create-venv", () => this._run(python, ["-m", "venv", venvPath], "create-venv", signal));
      const venvPython = this.platform === "win32"
        ? path.join(venvPath, "Scripts", "python.exe")
        : path.join(venvPath, "bin", "python");
      reportProgress({ phase: "upgrade-pip", percent: 50, message: "正在更新 pip。" });
      await this._step("upgrade-pip", () => this._run(venvPython, ["-m", "pip", "install", "--upgrade", "pip", "--index-url", sources.pipIndexUrl], "upgrade-pip", signal));
      if (!requirements.requirementsPath) {
        throw new EnvironmentBootstrapError("requirementsPath is required", "ENVIRONMENT_REQUIREMENTS_PATH_REQUIRED");
      }
      const installArgs = ["-m", "pip", "install", "-r", requiredPath(requirements.requirementsPath, "requirementsPath"), "--index-url", sources.pipIndexUrl];
      if (sources.torchIndexUrl) installArgs.push("--extra-index-url", sources.torchIndexUrl);
      if (sources.extraIndexUrl) installArgs.push("--extra-index-url", sources.extraIndexUrl);
      reportProgress({ phase: "install-requirements", percent: 60, message: "正在安装 Python 与 PyTorch 依赖。" });
      await this._step("install-requirements", () => this._run(venvPython, installArgs, "install-requirements", signal));
      reportProgress({ phase: "copy-ffmpeg", percent: 88, message: "正在准备应用内置 FFmpeg。" });
      const ffmpeg = await this._step("copy-ffmpeg", () => this._copyFfmpeg(stagingPath, ffmpegHash));
      this._setStatus(BOOTSTRAP_STATUS.PROBING);
      reportProgress({ phase: "health-probe", percent: 94, message: "正在校验 Python、PyTorch、后端模块与 FFmpeg。" });
      const health = await this._step("probe-environment", () => this.probe({
        root: stagingPath,
        pythonExecutable: venvPython,
        ffmpegPath: ffmpeg.path,
        accelerator: selectedAccelerator,
        platform: this.platform,
        baseEnv: this.baseEnv,
        signal,
      }));
      if (health?.success === false) {
        throw new EnvironmentBootstrapError("Environment health probe failed", "ENVIRONMENT_PROBE_FAILED", { health });
      }
      await this.fs.mkdir(stagingPath, { recursive: true });
      await this.fs.writeFile(path.join(stagingPath, "environment-spec.json"), `${JSON.stringify(spec, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await this.fs.writeFile(path.join(stagingPath, ".ready.json"), `${JSON.stringify({ schema: ENVIRONMENT_BOOTSTRAP_SCHEMA, specHash: spec.specHash, readyAt: new Date(this.now()).toISOString() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      const pointer = {
        schema: ENVIRONMENT_BOOTSTRAP_SCHEMA,
        accelerator: selectedAccelerator,
        specHash: spec.specHash,
        path: path.relative(this.rootDir, targetPath).replace(/\\/g, "/"),
        activatedAt: new Date(this.now()).toISOString(),
        pythonExecutableRelative: path.relative(targetPath, venvPython).replace(/\\/g, "/"),
        ffmpegRelative: path.relative(targetPath, ffmpeg.path).replace(/\\/g, "/"),
      };
      await this._step("activate", () => this._activate(stagingPath, targetPath, pointer, operationId, previous));
      stagingPath = null;
      if (previous && previous.specHash !== pointer.specHash) await this._appendHistory(previous);
      this._setStatus(BOOTSTRAP_STATUS.READY, { stagingPath: null, activePath: targetPath, finishedAt: this.now() });
      reportProgress({ phase: "complete", status: "complete", percent: 100, message: "运行环境创建并校验完成。" });
      return { success: true, created: true, reused: false, selection, spec, health, activePath: targetPath, state: this.getState() };
    } catch (error) {
      if (stagingPath) await this.fs.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
      const normalized = error instanceof EnvironmentBootstrapError
        ? error
        : new EnvironmentBootstrapError(error?.message || String(error), "ENVIRONMENT_BOOTSTRAP_FAILED", { cause: error });
      this._setStatus(BOOTSTRAP_STATUS.FAILED, { stagingPath: null, error: serializeError(normalized), finishedAt: this.now() });
      reportProgress({
        phase: lastProgress.phase || "failed",
        status: "failed",
        message: normalized.message,
        error: serializeError(normalized),
      });
      return { success: false, code: normalized.code, error: normalized.message, details: clone(normalized.details), state: this.getState() };
    }
  }

  async importOfflinePayload({
    payloadRoot,
    offlinePayloadRoot,
    manifest,
    payloadManifest,
    accelerator = "auto",
    force = false,
    signal,
  } = {}) {
    const startedAt = this.now();
    const operationId = makeOperationId(this.now);
    let stagingPath = null;
    this.state = {
      status: BOOTSTRAP_STATUS.STAGING,
      selectedAccelerator: null,
      selectionReason: null,
      operationId,
      stagingPath: null,
      activePath: (await this._activePointer())?.absolutePath || null,
      specHash: null,
      error: null,
      steps: [],
      startedAt,
      finishedAt: null,
    };
    try {
      const payloadRootPath = requiredPath(payloadRoot ?? offlinePayloadRoot, "offlinePayloadRoot");
      const verified = await this._step("verify-offline-payload", () =>
        this._verifyOfflineManifest(payloadRootPath, manifest ?? payloadManifest, accelerator));
      const spec = await this._step("build-offline-spec", () => this._offlineSpec(verified));
      this.state.selectedAccelerator = verified.selectedAccelerator;
      this.state.selectionReason = verified.selection.reason;
      this.state.specHash = spec.specHash;
      const previous = await this._activePointer();
      const targetPath = path.join(this.environmentsRoot, verified.selectedAccelerator, spec.specHash);
      if (!force && previous?.specHash === spec.specHash && previous?.absolutePath === targetPath) {
        const paths = await this._offlineRuntimePaths(targetPath, verified.entries);
        const health = await this._step("probe-offline-active", () => this.probe({
          root: targetPath,
          pythonExecutable: paths.pythonExecutable,
          ffmpegPath: paths.ffmpegPath,
          accelerator: verified.selectedAccelerator,
          platform: this.platform,
          baseEnv: this.baseEnv,
          signal,
        }));
        if (health?.success !== false) {
          this._setStatus(BOOTSTRAP_STATUS.READY, { activePath: targetPath, finishedAt: this.now() });
          return {
            success: true,
            created: false,
            reused: true,
            offline: true,
            payloadRoot: payloadRootPath,
            manifest: clone(verified.manifest),
            selection: verified.selection,
            spec,
            health,
            activePath: targetPath,
            modelsPath: path.join(payloadRootPath, "models"),
            state: this.getState(),
          };
        }
      }

      stagingPath = path.join(this.stagingRoot, operationId);
      this.state.stagingPath = stagingPath;
      await this.fs.mkdir(stagingPath, { recursive: true });
      await this._step("copy-offline-payload", () => this._copyOfflineEntries(stagingPath, verified.entries));
      const paths = await this._step("locate-offline-runtime", () => this._offlineRuntimePaths(stagingPath, verified.entries));
      if (paths.condaUnpackExecutable) {
        await this._step("relocate-offline-runtime", () => this._run(paths.condaUnpackExecutable, [], "relocate-offline-runtime", signal));
      }
      this._setStatus(BOOTSTRAP_STATUS.PROBING);
      const health = await this._step("probe-offline-environment", () => this.probe({
        root: stagingPath,
        pythonExecutable: paths.pythonExecutable,
        ffmpegPath: paths.ffmpegPath,
        accelerator: verified.selectedAccelerator,
        platform: this.platform,
        baseEnv: this.baseEnv,
        signal,
      }));
      if (health?.success === false) {
        throw new EnvironmentBootstrapError("Offline environment health probe failed", "ENVIRONMENT_PROBE_FAILED", { health });
      }
      await this.fs.writeFile(path.join(stagingPath, "environment-spec.json"), `${JSON.stringify(spec, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await this.fs.writeFile(path.join(stagingPath, ".ready.json"), `${JSON.stringify({
        schema: ENVIRONMENT_BOOTSTRAP_SCHEMA,
        specHash: spec.specHash,
        source: "offline-payload",
        payloadVariant: verified.variant,
        readyAt: new Date(this.now()).toISOString(),
      }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      const pointer = {
        schema: ENVIRONMENT_BOOTSTRAP_SCHEMA,
        accelerator: verified.selectedAccelerator,
        specHash: spec.specHash,
        path: path.relative(this.rootDir, targetPath).replace(/\\/g, "/"),
        activatedAt: new Date(this.now()).toISOString(),
        pythonExecutableRelative: path.relative(targetPath, paths.pythonExecutable).replace(/\\/g, "/"),
        ffmpegRelative: path.relative(targetPath, paths.ffmpegPath).replace(/\\/g, "/"),
        source: "offline-payload",
      };
      await this._step("activate-offline-payload", () => this._activate(stagingPath, targetPath, pointer, operationId, previous));
      stagingPath = null;
      if (previous && previous.specHash !== pointer.specHash) await this._appendHistory(previous);
      this._setStatus(BOOTSTRAP_STATUS.READY, { stagingPath: null, activePath: targetPath, finishedAt: this.now() });
      return {
        success: true,
        created: true,
        reused: false,
        offline: true,
        payloadRoot: payloadRootPath,
        manifest: clone(verified.manifest),
        selection: verified.selection,
        spec,
        health,
        activePath: targetPath,
        modelsPath: path.join(payloadRootPath, "models"),
        state: this.getState(),
      };
    } catch (error) {
      if (stagingPath) await this.fs.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
      const normalized = error instanceof EnvironmentBootstrapError
        ? error
        : new EnvironmentBootstrapError(error?.message || String(error), "ENVIRONMENT_PAYLOAD_IMPORT_FAILED", { cause: error });
      this._setStatus(BOOTSTRAP_STATUS.FAILED, {
        stagingPath: null,
        error: serializeError(normalized),
        finishedAt: this.now(),
      });
      return {
        success: false,
        offline: true,
        code: normalized.code,
        error: normalized.message,
        details: clone(normalized.details),
        state: this.getState(),
      };
    }
  }

  async rollback() {
    this._setStatus(BOOTSTRAP_STATUS.ROLLING_BACK);
    const history = await this._readJson(this.historyPath, []);
    const entries = Array.isArray(history) ? history : [];
    const current = await this._activePointer();
    const candidates = entries.slice().reverse().filter((entry) => entry?.specHash && entry.specHash !== current?.specHash);
    let previous = null;
    for (const entry of candidates) {
      const target = path.resolve(this.rootDir, entry.path || "");
      if (!target.startsWith(`${this.environmentsRoot}${path.sep}`)) continue;
      if (await this.fs.stat(target).then(() => true).catch(() => false)) {
        previous = entry;
        break;
      }
    }
    if (!previous) {
      const error = new EnvironmentBootstrapError("No previous environment is available", "ENVIRONMENT_ROLLBACK_UNAVAILABLE");
      this._setStatus(BOOTSTRAP_STATUS.FAILED, { error: serializeError(error), finishedAt: this.now() });
      return { success: false, code: error.code, error: error.message, state: this.getState() };
    }
    await this._writeJsonAtomic(this.activePointerPath, previous, "rollback");
    this._setStatus(BOOTSTRAP_STATUS.READY, {
      selectedAccelerator: previous.accelerator,
      specHash: previous.specHash,
      activePath: path.resolve(this.rootDir, previous.path),
      finishedAt: this.now(),
      error: null,
    });
    return { success: true, pointer: clone(previous), state: this.getState() };
  }
}

export async function bootstrapEnvironment(options = {}) {
  const manager = new EnvironmentBootstrap(options);
  return manager.bootstrap(options);
}

export function createEnvironmentBootstrap(options = {}) {
  return new EnvironmentBootstrap(options);
}

export async function importOfflinePayload(options = {}) {
  const manager = options.manager instanceof EnvironmentBootstrap
    ? options.manager
    : new EnvironmentBootstrap(options);
  return manager.importOfflinePayload(options);
}

export { defaultCommandRunner };
