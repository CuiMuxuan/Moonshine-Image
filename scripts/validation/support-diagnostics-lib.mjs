import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

import {
  APP_CONFIG_INTEGER_LIMITS,
  CONFIG_SCHEMA_VERSION as APP_CONFIG_SCHEMA_VERSION,
  DEFAULT_BRAND_COLORS,
  DEFAULT_TEMP_CLEANUP,
  IMAGE_OUTPUT_FORMAT_OPTIONS,
  IMAGE_OUTPUT_NAMING_MODES,
  IMAGE_PROCESSING_METHOD_OPTIONS,
  SLBR_LOCAL_INFERENCE_STRATEGY_OPTIONS,
  UI_BUTTON_SIZE_OPTIONS,
  VIDEO_ENCODING_QUALITY_PRESET_OPTIONS,
  VIDEO_INPAINT_COLOR_STABILIZATION_OPTIONS,
  VIDEO_INTERMEDIATE_FRAME_STRATEGY_OPTIONS,
  VIDEO_PROCESSING_ENGINE_OPTIONS,
  VIDEO_TEMPORAL_ENHANCEMENT_MODES,
  createDefaultAppConfig,
  getManagedFolderNameValidationError,
  isFiniteIntegerInRange,
  needsConfigMigration,
  normalizeConfigToCurrentSchema,
} from "../../src/shared/appConfigSchema.js";
import { validateShortcutConfig } from "../../src/utils/shortcutConfig.js";

export const SUPPORT_DIAGNOSTICS_SCHEMA = 1;
export const CONFIG_SCHEMA_VERSION = APP_CONFIG_SCHEMA_VERSION;
export const DEFAULT_BACKEND_PORT = 8080;
export const DEFAULT_CU130_DRIVER_MAJOR = 570;

const OUTPUT_LIMIT = 32 * 1024;
const JSON_MARKER = "__MOONSHINE_DIAGNOSTICS__";
const PYTHON_INVENTORY_MARKER = "__MOONSHINE_PYTHON_INVENTORY__";

function truncateTail(value, limit = OUTPUT_LIMIT) {
  const text = String(value ?? "");
  return text.length <= limit ? text : `[truncated ${text.length - limit} chars]\n${text.slice(-limit)}`;
}

export function portablePath(value, env = process.env) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const candidates = [
    [env.LOCALAPPDATA, "%LOCALAPPDATA%"],
    [env.APPDATA, "%APPDATA%"],
    [env.USERPROFILE, "%USERPROFILE%"],
    [env.TEMP, "%TEMP%"],
    [env.TMP, "%TEMP%"],
  ]
    .filter(([prefix]) => prefix)
    .sort((left, right) => String(right[0]).length - String(left[0]).length);
  const normalized = path.resolve(raw);
  for (const [prefix, token] of candidates) {
    const base = path.resolve(String(prefix));
    const relative = path.relative(base, normalized);
    if (relative === "") return token;
    if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) {
      return `${token}\\${relative}`;
    }
  }
  return normalized;
}

export async function pathType(target, fsImpl = fs) {
  if (!target) return null;
  try {
    const stats = await fsImpl.stat(target);
    if (stats.isFile()) return "file";
    if (stats.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    if (error?.code === "EACCES" || error?.code === "EPERM") return "inaccessible";
    throw error;
  }
}

export async function readJsonIfExists(filePath, fsImpl = fs) {
  try {
    return { present: true, value: JSON.parse(await fsImpl.readFile(filePath, "utf8")) };
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false, value: null };
    return { present: true, value: null, error: `Invalid JSON: ${error.message}` };
  }
}

export function runCommand(command, args = [], { timeoutMs = 60_000, cwd, env } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const stdout = [];
    const stderr = [];
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: Number.isInteger(result.code) ? result.code : null,
        stdout: truncateTail(Buffer.concat(stdout).toString("utf8")),
        stderr: truncateTail(Buffer.concat(stderr).toString("utf8")),
        ...result,
      });
    };
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: env || process.env,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", error: error.message });
      return;
    }
    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", (error) => finish({ error: error.message }));
    child.once("close", (code, signal) => finish({ code, signal: signal || null }));
    const timer = setTimeout(() => {
      child.kill();
      finish({ timedOut: true, error: `Command timed out after ${timeoutMs} ms` });
    }, timeoutMs);
  });
}

async function runnerCall(runner, command, args, options) {
  try {
    if (typeof runner === "function") return await runner(command, args, options);
    if (runner && typeof runner.run === "function") return await runner.run(command, args, options);
    return await runCommand(command, args, options);
  } catch (error) {
    return {
      code: Number.isFinite(Number(error?.exitCode ?? error?.code)) ? Number(error.exitCode ?? error.code) : null,
      stdout: error?.stdout || "",
      stderr: error?.stderr || error?.message || String(error),
      error: error?.message || String(error),
    };
  }
}

function normalizeCommandResult(value = {}) {
  return {
    code: Number.isInteger(value.code) ? value.code : null,
    stdout: truncateTail(value.stdout),
    stderr: truncateTail(value.stderr),
    error: value.error ? truncateTail(value.error, 2_000) : null,
    timedOut: Boolean(value.timedOut),
  };
}

export function parseNvidiaSmi(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.lastIndexOf(",");
      if (separator < 0) return { name: line, driverVersion: null };
      return {
        name: line.slice(0, separator).trim(),
        driverVersion: line.slice(separator + 1).trim() || null,
      };
    });
}

export function isCu130DriverCompatible(version, minimumMajor = DEFAULT_CU130_DRIVER_MAJOR) {
  const major = Number.parseInt(String(version ?? "").split(".")[0], 10);
  return Number.isInteger(major) && major >= minimumMajor;
}

export async function inspectHostEnvironment({
  runner = runCommand,
  platform = process.platform,
  arch = process.arch,
  minimumDriverMajor = DEFAULT_CU130_DRIVER_MAJOR,
  env = process.env,
} = {}) {
  const nvidiaResult = normalizeCommandResult(await runnerCall(
    runner,
    "nvidia-smi",
    ["--query-gpu=name,driver_version", "--format=csv,noheader"],
    { timeoutMs: 15_000 },
  ));
  const gpus = nvidiaResult.code === 0 ? parseNvidiaSmi(nvidiaResult.stdout) : [];
  const driverCompatible = gpus.length > 0 && gpus.every((gpu) => isCu130DriverCompatible(gpu.driverVersion, minimumDriverMajor));

  const nvccResult = normalizeCommandResult(await runnerCall(runner, "nvcc", ["--version"], { timeoutMs: 15_000 }));
  const toolkitMatch = `${nvccResult.stdout}\n${nvccResult.stderr}`.match(/release\s+([0-9]+(?:\.[0-9]+)?)/i);
  return {
    status: "pass",
    details: {
      schemaVersion: SUPPORT_DIAGNOSTICS_SCHEMA,
      platform,
      arch,
      osRelease: os.release(),
      cpu: {
        logicalProcessors: os.cpus()?.length || null,
        model: os.cpus()?.[0]?.model || null,
        totalMemoryBytes: os.totalmem(),
      },
      nvidia: {
        available: gpus.length > 0,
        commandAvailable: nvidiaResult.code === 0,
        gpus,
        minimumCu130DriverMajor: minimumDriverMajor,
        driverCompatible,
        error: nvidiaResult.code === 0 ? null : nvidiaResult.error || nvidiaResult.stderr || "nvidia-smi unavailable",
      },
      cudaToolkit: {
        requiredByPyTorch: false,
        available: nvccResult.code === 0,
        version: toolkitMatch?.[1] || null,
        configuredPath: portablePath(env.CUDA_PATH || env.CUDA_HOME, env),
      },
      automaticAccelerator: driverCompatible ? "cu130" : "cpu",
    },
  };
}

const PYTHON_INVENTORY_SCRIPT = String.raw`
import json
import platform
import sys

print("${PYTHON_INVENTORY_MARKER}" + json.dumps({
    "version": ".".join(map(str, sys.version_info[:3])),
    "versionInfo": list(sys.version_info[:3]),
    "executable": sys.executable,
    "prefix": sys.prefix,
    "basePrefix": sys.base_prefix,
    "architecture": platform.architecture()[0],
    "implementation": platform.python_implementation(),
    "isVirtualEnvironment": sys.prefix != sys.base_prefix,
}, ensure_ascii=True, separators=(",", ":")))
`;

function extractPythonPaths(value, platform = process.platform) {
  const results = [];
  for (const rawLine of String(value ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (platform === "win32") {
      const quoted = line.match(/"([A-Za-z]:[\\/][^"]*?python(?:w)?\.exe)"\s*$/i);
      const plain = line.match(/([A-Za-z]:[\\/].*?python(?:w)?\.exe)\s*$/i);
      const candidate = quoted?.[1] || plain?.[1];
      if (candidate) results.push(candidate);
      continue;
    }
    const candidate = line.split(/\s+/).at(-1);
    if (candidate && path.isAbsolute(candidate) && /^python(?:\d+(?:\.\d+)*)?$/i.test(path.basename(candidate))) {
      results.push(candidate);
    }
  }
  return results;
}

async function addPythonCandidatesFromDirectory(addCandidate, directory, source, fsImpl, platform) {
  if (!directory) return;
  const executableName = platform === "win32" ? "python.exe" : "python";
  const directCandidate = path.join(directory, executableName);
  if (await pathType(directCandidate, fsImpl) === "file") addCandidate(directCandidate, source);
  let children;
  try {
    children = await fsImpl.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const child of children) {
    if (!child.isDirectory() || !/^python/i.test(child.name)) continue;
    const candidate = path.join(directory, child.name, executableName);
    if (await pathType(candidate, fsImpl) === "file") addCandidate(candidate, source);
  }
}

export async function inspectPythonInstallations({
  runner = runCommand,
  fsImpl = fs,
  env = process.env,
  platform = process.platform,
  additionalCandidates = [],
  timeoutMs = 15_000,
} = {}) {
  const candidates = new Map();
  const addCandidate = (candidate, source) => {
    const raw = String(candidate || "").trim().replace(/^"|"$/g, "");
    if (!raw || !path.isAbsolute(raw)) return;
    const resolved = path.resolve(raw);
    const key = platform === "win32" ? resolved.toLowerCase() : resolved;
    const existing = candidates.get(key) || { path: resolved, sources: [] };
    if (!existing.sources.includes(source)) existing.sources.push(source);
    candidates.set(key, existing);
  };

  for (const candidate of additionalCandidates) addCandidate(candidate, "effective-environment");

  const launcherCommand = platform === "win32" ? "py.exe" : "python3";
  const launcherArgs = platform === "win32" ? ["-0p"] : ["-c", "import sys; print(sys.executable)"];
  const launcherResult = normalizeCommandResult(await runnerCall(runner, launcherCommand, launcherArgs, { timeoutMs }));
  if (launcherResult.code === 0) {
    for (const candidate of extractPythonPaths(launcherResult.stdout, platform)) addCandidate(candidate, "python-launcher");
  }

  const locatorCommand = platform === "win32" ? "where.exe" : "which";
  const locatorNames = platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"];
  const locatorResults = [];
  for (const name of locatorNames) {
    const result = normalizeCommandResult(await runnerCall(runner, locatorCommand, [name], { timeoutMs }));
    locatorResults.push({ name, result });
    if (result.code === 0) {
      for (const candidate of extractPythonPaths(result.stdout, platform)) addCandidate(candidate, "PATH");
    }
  }

  const condaResult = normalizeCommandResult(await runnerCall(runner, platform === "win32" ? "conda.exe" : "conda", ["info", "--envs", "--json"], { timeoutMs }));
  if (condaResult.code === 0) {
    try {
      const conda = JSON.parse(condaResult.stdout);
      for (const root of Array.isArray(conda.envs) ? conda.envs : []) {
        addCandidate(path.join(root, platform === "win32" ? "python.exe" : "bin/python"), "conda");
      }
    } catch {
      // Keep the raw command status in discovery metadata below.
    }
  }

  const pathValue = env.Path || env.PATH || "";
  for (const directory of String(pathValue).split(path.delimiter).filter(Boolean)) {
    await addPythonCandidatesFromDirectory(addCandidate, directory, "PATH", fsImpl, platform);
  }
  if (env.CONDA_PREFIX) {
    addCandidate(path.join(env.CONDA_PREFIX, platform === "win32" ? "python.exe" : "bin/python"), "active-conda");
  }
  if (platform === "win32") {
    if (env.LOCALAPPDATA) {
      await addPythonCandidatesFromDirectory(addCandidate, path.join(env.LOCALAPPDATA, "Programs", "Python"), "user-install", fsImpl, platform);
    }
    await addPythonCandidatesFromDirectory(addCandidate, env.ProgramFiles, "system-install", fsImpl, platform);
    await addPythonCandidatesFromDirectory(addCandidate, env["ProgramFiles(x86)"], "system-install-x86", fsImpl, platform);
  }

  const inventory = [];
  for (const candidate of [...candidates.values()].slice(0, 64)) {
    if (await pathType(candidate.path, fsImpl) !== "file") continue;
    const result = normalizeCommandResult(await runnerCall(
      runner,
      candidate.path,
      ["-I", "-c", PYTHON_INVENTORY_SCRIPT],
      { timeoutMs },
    ));
    let diagnostics = null;
    let diagnosticError = null;
    if (result.code === 0) {
      try {
        const line = result.stdout.split(/\r?\n/).reverse().find((item) => item.startsWith(PYTHON_INVENTORY_MARKER));
        if (!line) throw new Error("Python did not return structured version information");
        diagnostics = JSON.parse(line.slice(PYTHON_INVENTORY_MARKER.length));
      } catch (error) {
        diagnosticError = error.message;
      }
    }
    const versionInfo = Array.isArray(diagnostics?.versionInfo) ? diagnostics.versionInfo : [];
    const compatible = versionInfo[0] === 3 && versionInfo[1] === 12;
    inventory.push({
      path: portablePath(candidate.path, env),
      sources: candidate.sources,
      usable: result.code === 0 && Boolean(diagnostics),
      version: diagnostics?.version || null,
      compatible,
      architecture: diagnostics?.architecture || null,
      implementation: diagnostics?.implementation || null,
      isVirtualEnvironment: diagnostics?.isVirtualEnvironment ?? null,
      prefix: portablePath(diagnostics?.prefix, env),
      basePrefix: portablePath(diagnostics?.basePrefix, env),
      reportedExecutable: portablePath(diagnostics?.executable, env),
      error: result.code === 0 ? diagnosticError : result.error || result.stderr || result.stdout || `exit ${result.code}`,
    });
  }
  inventory.sort((left, right) => Number(right.compatible) - Number(left.compatible) || String(left.path).localeCompare(String(right.path)));
  const usableCount = inventory.filter((entry) => entry.usable).length;
  const compatibleCount = inventory.filter((entry) => entry.usable && entry.compatible).length;
  const issues = [];
  if (!usableCount) issues.push("No usable Python interpreter was found");
  else if (!compatibleCount) issues.push(`Found Python ${inventory.filter((entry) => entry.usable).map((entry) => entry.version).filter(Boolean).join(", ")}, but Moonshine-Image requires Python 3.12.x`);
  return {
    status: issues.length ? "fail" : "pass",
    details: {
      requiredVersion: "3.12.x",
      candidateCount: candidates.size,
      usableCount,
      compatibleCount,
      supportedPythonAvailable: compatibleCount > 0,
      interpreters: inventory,
      discovery: {
        pythonLauncherAvailable: launcherResult.code === 0,
        pathLocatorAvailable: locatorResults.some(({ result }) => result.code === 0),
        condaAvailable: condaResult.code === 0,
      },
      issues,
    },
  };
}

function timeoutSignal(milliseconds) {
  return typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(milliseconds) : undefined;
}

function publicUrl(value) {
  const url = new URL(String(value));
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function safePublicUrl(value) {
  try {
    return publicUrl(value);
  } catch {
    return "[invalid-url]";
  }
}

export async function probeNetworkEndpoint({
  id,
  url,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
} = {}) {
  const started = Date.now();
  try {
    const target = new URL(String(url));
    if (target.protocol !== "https:") throw new Error("Public diagnostics endpoint must use HTTPS");
    let method = "HEAD";
    let response = await fetchImpl(target, {
      method,
      cache: "no-store",
      redirect: "follow",
      signal: timeoutSignal(timeoutMs),
    });
    if ([405, 501].includes(response.status)) {
      method = "GET";
      response = await fetchImpl(target, {
        method,
        headers: { Range: "bytes=0-0" },
        cache: "no-store",
        redirect: "follow",
        signal: timeoutSignal(timeoutMs),
      });
    }
    await response.body?.cancel?.().catch?.(() => {});
    const reachable = response.status < 500;
    return {
      id: String(id || "endpoint"),
      status: reachable ? "pass" : "fail",
      details: {
        url: publicUrl(target),
        method,
        httpStatus: response.status,
        redirected: Boolean(response.redirected),
        durationMs: Date.now() - started,
        reachable,
      },
      ...(reachable ? {} : { error: `Endpoint returned HTTP ${response.status}` }),
    };
  } catch (error) {
    return {
      id: String(id || "endpoint"),
      status: "fail",
      details: { url: safePublicUrl(url), durationMs: Date.now() - started, reachable: false },
      error: truncateTail(error.message, 2_000),
    };
  }
}

function validPathSetting(value, label, issues) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    issues.push(`${label} must be a path string`);
    return null;
  }
  return path.resolve(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function collectSchemaProblems(candidate, defaults, prefix, issues, warnings) {
  for (const [key, defaultValue] of Object.entries(defaults)) {
    const field = prefix ? `${prefix}.${key}` : key;
    if (!Object.prototype.hasOwnProperty.call(candidate, key)) {
      warnings.push(`${field} is missing and will use the application default`);
      continue;
    }
    const value = candidate[key];
    if (isPlainObject(defaultValue)) {
      if (!isPlainObject(value)) issues.push(`${field} must be an object`);
      else collectSchemaProblems(value, defaultValue, field, issues, warnings);
      continue;
    }
    if (Array.isArray(defaultValue)) {
      if (!Array.isArray(value)) issues.push(`${field} must be an array`);
      continue;
    }
    if (typeof value !== typeof defaultValue) issues.push(`${field} has an invalid value type`);
  }
}

function collectNormalizedPaths(candidate, normalized, prefix = "", output = []) {
  if (output.length >= 100) return output;
  if (isPlainObject(candidate) && isPlainObject(normalized)) {
    const keys = new Set([...Object.keys(candidate), ...Object.keys(normalized)]);
    for (const key of keys) {
      collectNormalizedPaths(candidate[key], normalized[key], prefix ? `${prefix}.${key}` : key, output);
      if (output.length >= 100) break;
    }
    return output;
  }
  if (JSON.stringify(candidate) !== JSON.stringify(normalized)) output.push(prefix || "root");
  return output;
}

function pushEnumIssue(issues, field, value, options) {
  if (!options.includes(value)) issues.push(`${field} has an unsupported value`);
}

function pushIntegerIssue(issues, field, value, limits) {
  if (!isFiniteIntegerInRange(value, limits)) issues.push(`${field} is outside its supported integer range`);
}

function validateEffectiveConfig(config, issues) {
  const { general, advanced, masking, ui, fileManagement, video } = config;
  pushIntegerIssue(issues, "general.backendPort", general.backendPort, { min: 1024, max: 65535 });
  pushEnumIssue(issues, "general.launchMode", general.launchMode, ["cpu", "cuda"]);
  pushEnumIssue(issues, "general.defaultModel", String(general.defaultModel).toLowerCase(), ["lama", "mat"]);

  for (const [field, limits] of Object.entries(APP_CONFIG_INTEGER_LIMITS)) {
    if (Object.prototype.hasOwnProperty.call(advanced, field)) {
      pushIntegerIssue(issues, `advanced.${field}`, advanced[field], limits);
    }
  }
  pushEnumIssue(issues, "advanced.imageProcessingMethod", advanced.imageProcessingMethod, IMAGE_PROCESSING_METHOD_OPTIONS);
  pushEnumIssue(issues, "advanced.slbrLocalInferenceStrategy", advanced.slbrLocalInferenceStrategy, SLBR_LOCAL_INFERENCE_STRATEGY_OPTIONS);
  pushEnumIssue(issues, "advanced.imageOutputFormat", advanced.imageOutputFormat, IMAGE_OUTPUT_FORMAT_OPTIONS);
  pushEnumIssue(issues, "advanced.imageOutputNamingMode", advanced.imageOutputNamingMode, IMAGE_OUTPUT_NAMING_MODES);
  pushEnumIssue(issues, "advanced.videoProcessingEngine", advanced.videoProcessingEngine, VIDEO_PROCESSING_ENGINE_OPTIONS);
  pushIntegerIssue(issues, "advanced.imageOutputQuality", advanced.imageOutputQuality, { min: 1, max: 100 });
  if (!String(advanced.imageOutputFixedPrefix || "").trim()) issues.push("advanced.imageOutputFixedPrefix cannot be empty");

  for (const [field, limits] of Object.entries({
    samRenderCacheMaxContexts: { min: 1, max: 50 },
    samRenderCacheMaxMemoryMb: { min: 32, max: 1024 },
    samRenderCacheLargeImageLongSide: { min: 1024, max: 12000 },
    samRenderCacheNeighborPreloadCount: { min: 0, max: 10 },
  })) pushIntegerIssue(issues, `masking.${field}`, masking[field], limits);
  for (const field of [
    "samRenderCacheEnabled",
    "samLazyRenderDisabledCandidates",
    "samRenderCachePreloadVisibleList",
    "samReleaseBeforeProcessing",
  ]) {
    if (typeof masking[field] !== "boolean") issues.push(`masking.${field} must be boolean`);
  }

  pushEnumIssue(issues, "ui.theme", ui.theme, ["light", "dark"]);
  pushEnumIssue(issues, "ui.buttonSize", ui.buttonSize, UI_BUTTON_SIZE_OPTIONS);
  for (const key of Object.keys(DEFAULT_BRAND_COLORS)) {
    if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(ui.brandColors?.[key] || ""))) {
      issues.push(`ui.brandColors.${key} must be a Hex color`);
    }
  }

  for (const field of ["downloadPath", "tempPath"]) {
    if (typeof fileManagement[field] !== "string") issues.push(`fileManagement.${field} must be a path string`);
  }
  for (const field of ["imageFolderName", "videoFolderName"]) {
    const error = getManagedFolderNameValidationError(fileManagement[field]);
    if (error) issues.push(`fileManagement.${field}${error}`);
  }
  const tempCleanup = fileManagement.tempCleanup;
  if (Object.keys(tempCleanup).some((key) => !Object.prototype.hasOwnProperty.call(DEFAULT_TEMP_CLEANUP, key))) {
    issues.push("fileManagement.tempCleanup contains unsupported fields");
  }
  for (const field of ["enabled", "onStartup", "includeImages", "includeVideos", "keepRecentFailures"]) {
    if (typeof tempCleanup[field] !== "boolean") issues.push(`fileManagement.tempCleanup.${field} must be boolean`);
  }
  pushIntegerIssue(issues, "fileManagement.tempCleanup.maxAgeDays", tempCleanup.maxAgeDays, { min: 1, max: 365 });

  for (const [field, limits] of Object.entries({
    batchFrameCount: { min: 1 },
    historyLimit: { min: 1, max: 50 },
    batchRetryCount: { min: 1, max: 10 },
    failureRetentionCount: { min: 1, max: 50 },
    proxyMaxSide: { min: 256, max: 4096 },
  })) pushIntegerIssue(issues, `video.${field}`, video[field], limits);
  pushEnumIssue(issues, "video.frameExtractionFormat", String(video.frameExtractionFormat).toLowerCase(), ["jpg", "jpeg", "png", "webp"]);
  pushEnumIssue(issues, "video.intermediateFrameStrategy", video.intermediateFrameStrategy, VIDEO_INTERMEDIATE_FRAME_STRATEGY_OPTIONS);
  pushEnumIssue(issues, "video.encodingQualityPreset", video.encodingQualityPreset, VIDEO_ENCODING_QUALITY_PRESET_OPTIONS);
  pushEnumIssue(issues, "video.inpaintColorStabilization", video.inpaintColorStabilization, VIDEO_INPAINT_COLOR_STABILIZATION_OPTIONS);
  if (![3, 10].includes(Number(video.previewTrialSeconds))) issues.push("video.previewTrialSeconds must be 3 or 10");
  pushEnumIssue(issues, "video.temporalEnhancement.mode", video.temporalEnhancement.mode, VIDEO_TEMPORAL_ENHANCEMENT_MODES);
  issues.push(...validateShortcutConfig(config.shortcuts));
}

export async function inspectConfiguration({ userData, configPath, fsImpl = fs, env = process.env } = {}) {
  const resolvedPath = path.resolve(configPath || path.join(String(userData || ""), "config", "config.json"));
  const loaded = await readJsonIfExists(resolvedPath, fsImpl);
  if (!loaded.present) {
    const defaults = createDefaultAppConfig();
    return {
      status: "pass",
      details: {
        path: portablePath(resolvedPath, env),
        present: false,
        usingDefaults: true,
        schemaVersion: CONFIG_SCHEMA_VERSION,
        backendPort: defaults.general.backendPort,
        launchMode: defaults.general.launchMode,
        defaultModel: defaults.general.defaultModel,
        issues: [],
        warnings: [],
        migrationRequired: false,
      },
      effective: {
        backendPort: defaults.general.backendPort,
        launchMode: defaults.general.launchMode,
        defaultModel: defaults.general.defaultModel,
        backendProjectPath: null,
        modelDir: null,
      },
    };
  }
  if (loaded.error || !loaded.value || typeof loaded.value !== "object" || Array.isArray(loaded.value)) {
    return {
      status: "fail",
      details: { path: portablePath(resolvedPath, env), present: true, issues: [loaded.error || "Configuration root must be an object"] },
      effective: null,
    };
  }
  const config = loaded.value;
  const issues = [];
  const warnings = [];
  const schemaVersion = Number(config.schemaVersion || 0);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) issues.push("schemaVersion is missing or invalid");
  else if (schemaVersion > CONFIG_SCHEMA_VERSION) issues.push(`schemaVersion ${schemaVersion} is newer than supported ${CONFIG_SCHEMA_VERSION}`);
  else if (schemaVersion < CONFIG_SCHEMA_VERSION) warnings.push(`schemaVersion ${schemaVersion} will be migrated by the application`);
  collectSchemaProblems(config, createDefaultAppConfig(), "", issues, warnings);
  const normalized = normalizeConfigToCurrentSchema(config);
  validateEffectiveConfig(normalized, issues);
  const migrationRequired = needsConfigMigration(config);
  const normalizedFields = collectNormalizedPaths(config, normalized);
  if (migrationRequired && schemaVersion === CONFIG_SCHEMA_VERSION) {
    warnings.push("The application will normalize one or more configuration fields");
  }
  const backendPort = Number(normalized.general.backendPort);
  const launchMode = String(normalized.general.launchMode).toLowerCase();
  const defaultModel = String(normalized.general.defaultModel).toLowerCase();
  const backendProjectPath = validPathSetting(normalized.general.backendProjectPath, "general.backendProjectPath", issues);
  const modelDir = validPathSetting(normalized.general.modelDir, "general.modelDir", issues);
  if (backendProjectPath && await pathType(backendProjectPath, fsImpl) !== "directory") {
    issues.push("general.backendProjectPath does not exist or is not a directory");
  }
  if (modelDir && await pathType(modelDir, fsImpl) !== "directory") {
    warnings.push("general.modelDir does not currently exist; models may not be available");
  }
  return {
    status: issues.length ? "fail" : "pass",
    details: {
      path: portablePath(resolvedPath, env),
      present: true,
      usingDefaults: false,
      schemaVersion: Number.isFinite(schemaVersion) ? schemaVersion : null,
      backendPort: Number.isFinite(backendPort) ? backendPort : null,
      launchMode,
      defaultModel,
      backendProjectPath: portablePath(backendProjectPath, env),
      modelDir: portablePath(modelDir, env),
      issues,
      warnings,
      migrationRequired,
      normalizedFieldCount: normalizedFields.length,
      normalizedFields: normalizedFields.slice(0, 40),
    },
    effective: issues.length ? null : { backendPort, launchMode, defaultModel, backendProjectPath, modelDir },
  };
}

function normalizePackageName(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[-_.]+/g, "-");
}

export function environmentRootFromPython(pythonExecutable) {
  const pythonPath = path.resolve(String(pythonExecutable || ""));
  const parent = path.dirname(pythonPath);
  return ["scripts", "bin"].includes(path.basename(parent).toLowerCase()) ? path.dirname(parent) : parent;
}

export function parseRequirementsLock(value) {
  const packages = [];
  for (const rawLine of String(value ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("--")) continue;
    const match = line.match(/^([A-Za-z0-9._-]+)(?:\[([^\]]+)\])?\s*==\s*([^\s;]+)/);
    if (!match) continue;
    packages.push({
      name: normalizePackageName(match[1]),
      version: match[3],
      extras: match[2] ? match[2].split(",").map((item) => item.trim()).filter(Boolean) : [],
    });
  }
  return packages;
}

function parseMarkedJson(stdout) {
  const line = String(stdout ?? "").split(/\r?\n/).reverse().find((item) => item.startsWith(JSON_MARKER));
  if (!line) throw new Error("Python diagnostics did not return structured output");
  return JSON.parse(line.slice(JSON_MARKER.length));
}

const PYTHON_DIAGNOSTIC_SCRIPT = String.raw`
import importlib
import importlib.metadata as metadata
import json
import os
import sys

expected = json.loads(sys.argv[1])
backend_root = sys.argv[2]
flavor = sys.argv[3]
result = {
    "python": {"version": ".".join(map(str, sys.version_info[:3])), "compatible": sys.version_info[:2] == (3, 12)},
    "packages": {"expectedCount": len(expected), "installedCount": 0, "missing": [], "mismatched": []},
    "imports": {"failed": []},
    "backend": {"ok": False, "error": None},
    "torch": {"ok": False, "version": None, "cudaBuild": None, "cudaAvailable": False, "deviceCount": 0, "device": None, "capability": None, "deviceSelected": False, "operationOk": False, "error": None},
}
for package in expected:
    try:
        installed = metadata.version(package["name"])
        result["packages"]["installedCount"] += 1
        if installed != package["version"]:
            result["packages"]["mismatched"].append({"name": package["name"], "expected": package["version"], "actual": installed})
    except metadata.PackageNotFoundError:
        result["packages"]["missing"].append(package["name"])

modules = {
    "torch": "torch", "torchvision": "torchvision", "opencv-python": "cv2", "scipy": "scipy",
    "scikit-image": "skimage", "huggingface-hub": "huggingface_hub", "transformers": "transformers",
    "timm": "timm", "fastapi": "fastapi", "uvicorn": "uvicorn", "python-socketio": "socketio",
    "typer": "typer", "pydantic": "pydantic", "rich": "rich", "loguru": "loguru", "yacs": "yacs",
    "pillow": "PIL", "rembg": "rembg",
}
for package in expected:
    module = modules.get(package["name"])
    if not module:
        continue
    try:
        importlib.import_module(module)
    except Exception as exc:
        result["imports"]["failed"].append({"package": package["name"], "error": f"{type(exc).__name__}: {exc}"})

if backend_root:
    sys.path.insert(0, backend_root)
try:
    importlib.import_module("moonshine_server")
    result["backend"]["ok"] = True
except Exception as exc:
    result["backend"]["error"] = f"{type(exc).__name__}: {exc}"

try:
    import torch
    result["torch"].update({
        "ok": True,
        "version": str(torch.__version__),
        "cudaBuild": torch.version.cuda,
        "cudaAvailable": bool(torch.cuda.is_available()),
        "deviceCount": int(torch.cuda.device_count()),
    })
    if torch.cuda.is_available() and torch.cuda.device_count() > 0:
        torch.cuda.set_device(0)
        device = torch.device("cuda:0")
        result["torch"]["deviceSelected"] = torch.cuda.current_device() == 0
        result["torch"]["device"] = torch.cuda.get_device_name(0)
        result["torch"]["capability"] = list(torch.cuda.get_device_capability(0))
        value = (torch.arange(5, device=device, dtype=torch.float32) + 1).sum().item()
        torch.cuda.synchronize(device)
        result["torch"]["operationOk"] = abs(value - 15.0) < 0.001
except Exception as exc:
    result["torch"]["error"] = f"{type(exc).__name__}: {exc}"

print("${JSON_MARKER}" + json.dumps(result, ensure_ascii=True, separators=(",", ":")))
`;

export async function inspectPythonEnvironment({
  pythonExecutable,
  backendProjectPath,
  flavor = "cpu",
  lockPath,
  runner = runCommand,
  fsImpl = fs,
  env = process.env,
  timeoutMs = 180_000,
} = {}) {
  const pythonPath = path.resolve(String(pythonExecutable || ""));
  if (await pathType(pythonPath, fsImpl) !== "file") {
    return { status: "fail", details: { pythonExecutable: portablePath(pythonPath, env), issues: ["Python executable is missing"] } };
  }
  let expectedPackages = [];
  const issues = [];
  try {
    expectedPackages = parseRequirementsLock(await fsImpl.readFile(lockPath, "utf8"));
    if (!expectedPackages.length) issues.push("Requirements lock contains no pinned packages");
  } catch (error) {
    issues.push(`Requirements lock is unavailable: ${error.message}`);
  }
  const pipCheck = normalizeCommandResult(await runnerCall(
    runner,
    pythonPath,
    ["-m", "pip", "check"],
    { timeoutMs },
  ));
  if (pipCheck.code !== 0) issues.push(`pip check failed: ${pipCheck.stderr || pipCheck.stdout || pipCheck.error || `exit ${pipCheck.code}`}`);

  const probeCommand = normalizeCommandResult(await runnerCall(
    runner,
    pythonPath,
    ["-c", PYTHON_DIAGNOSTIC_SCRIPT, JSON.stringify(expectedPackages), backendProjectPath || "", String(flavor || "cpu")],
    { timeoutMs },
  ));
  let diagnostics = null;
  if (probeCommand.code !== 0) {
    issues.push(`Python diagnostics failed: ${probeCommand.stderr || probeCommand.stdout || probeCommand.error || `exit ${probeCommand.code}`}`);
  } else {
    try {
      diagnostics = parseMarkedJson(probeCommand.stdout);
    } catch (error) {
      issues.push(error.message);
    }
  }
  if (diagnostics) {
    if (!diagnostics.python?.compatible) issues.push(`Python ${diagnostics.python?.version || "unknown"} is not supported; expected 3.12.x`);
    if (diagnostics.packages?.missing?.length) issues.push(`${diagnostics.packages.missing.length} required packages are missing`);
    if (diagnostics.packages?.mismatched?.length) issues.push(`${diagnostics.packages.mismatched.length} required package versions do not match`);
    if (diagnostics.imports?.failed?.length) issues.push(`${diagnostics.imports.failed.length} required packages cannot be imported`);
    if (!diagnostics.backend?.ok) issues.push(`Backend module import failed: ${diagnostics.backend?.error || "unknown error"}`);
    if (!diagnostics.torch?.ok) issues.push(`PyTorch import failed: ${diagnostics.torch?.error || "unknown error"}`);
  }
  return {
    status: issues.length ? "fail" : "pass",
    details: {
      pythonExecutable: portablePath(pythonPath, env),
      environmentRoot: portablePath(environmentRootFromPython(pythonPath), env),
      backendProjectPath: portablePath(backendProjectPath, env),
      flavor,
      requirementsLock: portablePath(lockPath, env),
      pipCheck: { ok: pipCheck.code === 0, code: pipCheck.code, diagnostic: pipCheck.code === 0 ? null : pipCheck.stderr || pipCheck.stdout || pipCheck.error },
      diagnostics,
      issues,
    },
    diagnostics,
  };
}

export function evaluateCudaCompatibility({ host, environment, flavor = "cpu", minimumDriverMajor = DEFAULT_CU130_DRIVER_MAJOR } = {}) {
  if (String(flavor).toLowerCase() !== "cu130") {
    return { status: "skip", details: { reason: "The effective environment is CPU; CUDA is not required" } };
  }
  const nvidia = host?.nvidia || {};
  const torch = environment?.torch || {};
  const checks = {
    nvidiaGpuPresent: Boolean(nvidia.available),
    driverCompatible: Boolean(nvidia.available && nvidia.driverCompatible),
    pytorchCudaBuild: /^13(?:\.0)?(?:\D|$)/.test(String(torch.cudaBuild || "")),
    pytorchCudaAvailable: Boolean(torch.cudaAvailable),
    devicePresent: Number(torch.deviceCount) > 0,
    deviceSelected: Boolean(torch.deviceSelected),
    tensorOperation: Boolean(torch.operationOk),
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return {
    status: failed.length ? "fail" : "pass",
    details: {
      expected: { flavor: "cu130", cudaBuild: "13.0", minimumDriverMajor },
      checks,
      failed,
      driverVersions: (nvidia.gpus || []).map((gpu) => gpu.driverVersion),
      torchCudaBuild: torch.cudaBuild || null,
      device: torch.device || null,
      computeCapability: torch.capability || null,
      operationError: torch.error || null,
    },
  };
}

function samePath(left, right, platform = process.platform) {
  if (!left || !right) return null;
  const leftPath = path.resolve(left);
  const rightPath = path.resolve(right);
  return platform === "win32" ? leftPath.toLowerCase() === rightPath.toLowerCase() : leftPath === rightPath;
}

function processExists(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function probeLocalHealth(port, fetchImpl, timeoutMs) {
  const url = `http://127.0.0.1:${port}/api/v1/health?_=${Date.now()}`;
  try {
    const response = await fetchImpl(url, { method: "GET", cache: "no-store", signal: timeoutSignal(timeoutMs) });
    const body = await response.json().catch(() => null);
    return { ok: response.ok && body?.status === "ok", httpStatus: response.status, status: body?.status || null };
  } catch (error) {
    return { ok: false, httpStatus: null, status: null, error: truncateTail(error.message, 2_000) };
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function reserveLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!Number.isInteger(port)) reject(new Error("Unable to reserve a loopback port"));
        else resolve(port);
      });
    });
  });
}

async function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode) return true;
  return await Promise.race([
    new Promise((resolve) => {
      child.once("close", () => resolve(true));
      child.once("error", () => resolve(true));
    }),
    delay(timeoutMs).then(() => false),
  ]);
}

async function terminateSpawnedProcess(child, {
  platform = process.platform,
  runner = runCommand,
} = {}) {
  if (!child || child.exitCode !== null || child.signalCode) return { requested: false, exited: true };
  try {
    child.kill("SIGTERM");
  } catch {
    // Continue to the exact-PID fallback below.
  }
  if (await waitForChildExit(child, 3_000)) return { requested: true, exited: true, method: "SIGTERM" };
  if (platform === "win32" && Number.isInteger(Number(child.pid)) && Number(child.pid) > 0) {
    const result = normalizeCommandResult(await runnerCall(
      runner,
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      { timeoutMs: 15_000 },
    ));
    return {
      requested: true,
      exited: await waitForChildExit(child, 3_000),
      method: "taskkill",
      code: result.code,
      diagnostic: result.code === 0 ? null : result.stderr || result.stdout || result.error,
    };
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The process may have exited between the checks.
  }
  return { requested: true, exited: await waitForChildExit(child, 3_000), method: "SIGKILL" };
}

export async function probeConfiguredService({
  pythonExecutable,
  serviceProjectPath,
  flavor = "cpu",
  launchMode = "cpu",
  model = "lama",
  modelDir,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  reservePort = reserveLoopbackPort,
  terminateImpl = terminateSpawnedProcess,
  fsImpl = fs,
  env = process.env,
  platform = process.platform,
  timeoutMs = 180_000,
  pollIntervalMs = 500,
} = {}) {
  const startedAt = Date.now();
  const pythonPath = path.resolve(String(pythonExecutable || ""));
  const serviceRoot = path.resolve(String(serviceProjectPath || ""));
  const normalizedFlavor = String(flavor || "cpu").toLowerCase() === "cu130" ? "cu130" : "cpu";
  const normalizedLaunchMode = String(launchMode || "cpu").toLowerCase() === "cuda" ? "cuda" : "cpu";
  const expectedFlavor = normalizedLaunchMode === "cuda" ? "cu130" : "cpu";
  const issues = [];
  if (await pathType(pythonPath, fsImpl) !== "file") issues.push("Configured Python executable is missing");
  if (await pathType(serviceRoot, fsImpl) !== "directory") issues.push("Configured service project path is missing");
  if (await pathType(path.join(serviceRoot, "main.py"), fsImpl) !== "file") issues.push("Configured service entry point main.py is missing");
  if (normalizedFlavor !== expectedFlavor) {
    issues.push(`Configured ${normalizedLaunchMode} service requires ${expectedFlavor}, but the effective environment is ${normalizedFlavor}`);
  }
  if (issues.length) {
    return {
      status: "fail",
      details: {
        mode: "isolated",
        pythonExecutable: portablePath(pythonPath, env),
        serviceProjectPath: portablePath(serviceRoot, env),
        flavor: normalizedFlavor,
        launchMode: normalizedLaunchMode,
        expectedFlavor,
        issues,
      },
    };
  }

  const port = await reservePort();
  const modelDirectory = await pathType(modelDir, fsImpl) === "directory" ? path.resolve(modelDir) : null;
  const args = [
    "main.py",
    "start",
    `--model=${String(model || "lama").toLowerCase()}`,
    `--device=${normalizedLaunchMode}`,
    `--port=${port}`,
    "--local-files-only",
  ];
  if (modelDirectory) args.push(`--model-dir=${modelDirectory}`);
  const childEnv = {
    ...env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONNOUSERSITE: "1",
    PYTHONPATH: env.PYTHONPATH ? `${serviceRoot}${path.delimiter}${env.PYTHONPATH}` : serviceRoot,
    MOONSHINE_RUNTIME_FLAVOR: normalizedFlavor,
    ...(modelDirectory ? {
      TORCH_HOME: modelDirectory,
      XDG_CACHE_HOME: modelDirectory,
      U2NET_HOME: modelDirectory,
      HF_HOME: path.join(modelDirectory, "huggingface"),
    } : {}),
  };
  let child = null;
  let stdout = "";
  let stderr = "";
  let exit = null;
  let health = null;
  let termination = null;
  try {
    child = spawnImpl(pythonPath, args, {
      cwd: serviceRoot,
      env: childEnv,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => { stdout = truncateTail(`${stdout}${Buffer.from(chunk).toString("utf8")}`); });
    child.stderr?.on("data", (chunk) => { stderr = truncateTail(`${stderr}${Buffer.from(chunk).toString("utf8")}`); });
    child.once("error", (error) => { exit = { code: null, signal: null, error: error.message }; });
    child.once("close", (code, signal) => { exit = { code, signal: signal || null, error: null }; });

    while (Date.now() - startedAt < timeoutMs) {
      health = await probeLocalHealth(port, fetchImpl, Math.min(3_000, timeoutMs));
      if (health.ok) break;
      if (exit) break;
      await delay(pollIntervalMs);
    }
    if (!health?.ok) {
      if (exit) issues.push(`Configured service exited before becoming healthy${Number.isInteger(exit.code) ? ` (exit ${exit.code})` : ""}`);
      else issues.push(`Configured service did not become healthy within ${timeoutMs} ms`);
    }
  } catch (error) {
    issues.push(`Configured service could not be started: ${error.message}`);
  } finally {
    if (child) {
      try {
        termination = await terminateImpl(child, { platform, runner: runCommand });
      } catch (error) {
        termination = { requested: true, exited: false, diagnostic: error.message };
      }
    }
  }
  return {
    status: issues.length ? "fail" : "pass",
    details: {
      mode: "isolated",
      safety: "random loopback port, local model files only, validator-owned process",
      pythonExecutable: portablePath(pythonPath, env),
      serviceProjectPath: portablePath(serviceRoot, env),
      modelDir: portablePath(modelDirectory, env),
      flavor: normalizedFlavor,
      launchMode: normalizedLaunchMode,
      expectedFlavor,
      port,
      args,
      pid: Number(child?.pid) || null,
      health,
      exit,
      termination,
      stdout: truncateTail(stdout),
      stderr: truncateTail(stderr),
      durationMs: Date.now() - startedAt,
      issues,
    },
  };
}

export async function inspectEffectiveRuntime({
  userData,
  installRoot,
  configuredServiceProjectPath,
  configuredPort,
  configuredAccelerator,
  fetchImpl = globalThis.fetch,
  fsImpl = fs,
  env = process.env,
  platform = process.platform,
  isProcessAlive = processExists,
  timeoutMs = 10_000,
} = {}) {
  const receiptPath = path.join(path.resolve(String(userData || "")), "diagnostics", "effective-runtime.json");
  const loaded = await readJsonIfExists(receiptPath, fsImpl);
  if (!loaded.present) {
    return { status: "skip", details: { receiptPath: portablePath(receiptPath, env), reason: "No effective runtime receipt; the application may not be running" }, effective: null };
  }
  if (loaded.error || !loaded.value || typeof loaded.value !== "object") {
    return { status: "fail", details: { receiptPath: portablePath(receiptPath, env), issues: [loaded.error || "Effective runtime receipt is invalid"] }, effective: null };
  }
  const receipt = loaded.value;
  const issues = [];
  const serviceProjectType = await pathType(receipt.serviceProjectPath, fsImpl);
  const pythonType = await pathType(receipt.pythonExecutable, fsImpl);
  const environmentType = await pathType(receipt.environmentRoot, fsImpl);
  if (serviceProjectType !== "directory") issues.push("Effective service project path is missing");
  if (pythonType !== "file") issues.push("Effective Python executable is missing");
  if (environmentType !== "directory") issues.push("Effective environment path is missing");
  const appProcessAlive = isProcessAlive(Number(receipt.appProcessId ?? receipt.appPid));
  const serviceProcessAlive = isProcessAlive(Number(receipt.serviceProcessId ?? receipt.servicePid));
  const expectedServicePath = configuredServiceProjectPath
    ? path.resolve(configuredServiceProjectPath)
    : installRoot
      ? path.join(path.resolve(installRoot), "resources", "backend", "server")
      : null;
  const packagedServiceMatches = expectedServicePath ? samePath(receipt.serviceProjectPath, expectedServicePath, platform) : null;
  if (expectedServicePath && packagedServiceMatches === false) issues.push("Effective service path does not match the installed packaged service");
  if (receipt.status === "running" && !appProcessAlive) issues.push("Receipt says running but the application process is absent");
  if (receipt.status === "running" && !serviceProcessAlive) issues.push("Receipt says running but the service process is absent");
  const port = Number(receipt.port || configuredPort || DEFAULT_BACKEND_PORT);
  if (configuredPort && Number(configuredPort) !== port) issues.push("Effective service port does not match configuration");
  const expectedAccelerator = configuredAccelerator === "cuda" ? "cu130" : configuredAccelerator === "cpu" ? "cpu" : null;
  if (expectedAccelerator && receipt.accelerator && receipt.accelerator !== expectedAccelerator) {
    issues.push("Effective environment accelerator does not match configuration");
  }
  const health = receipt.status === "running" && serviceProcessAlive
    ? await probeLocalHealth(port, fetchImpl, timeoutMs)
    : { ok: false, skipped: true, reason: "Service is not currently running" };
  if (!health.skipped && !health.ok) issues.push("Configured service health endpoint is unavailable");
  return {
    status: issues.length ? "fail" : receipt.status === "running" ? "pass" : "skip",
    details: {
      receiptPath: portablePath(receiptPath, env),
      receiptStatus: receipt.status || null,
      recordedAt: receipt.recordedAt || receipt.updatedAt || receipt.startedAt || null,
      appProcessAlive,
      serviceProcessAlive,
      serviceProjectPath: portablePath(receipt.serviceProjectPath, env),
      expectedPackagedServicePath: portablePath(expectedServicePath, env),
      packagedServiceMatches,
      pythonExecutable: portablePath(receipt.pythonExecutable, env),
      environmentRoot: portablePath(receipt.environmentRoot, env),
      environmentSource: receipt.environmentSource || null,
      accelerator: receipt.accelerator || null,
      expectedAccelerator,
      specHash: receipt.specHash || null,
      port,
      health,
      issues,
    },
    effective: receipt,
  };
}

export async function inspectExternalEnvironment({ userData, fsImpl = fs, env = process.env } = {}) {
  const configPath = path.join(path.resolve(String(userData || "")), "environments", "external.json");
  const loaded = await readJsonIfExists(configPath, fsImpl);
  if (!loaded.present) return { status: "skip", details: { configured: false, path: portablePath(configPath, env) }, effective: null };
  const environment = loaded.value?.environment;
  const issues = [];
  if (loaded.error) issues.push(loaded.error);
  if (!environment || typeof environment !== "object") issues.push("External environment configuration is invalid");
  if (environment && await pathType(environment.normalizedPath, fsImpl) !== "directory") issues.push("External environment path is missing");
  if (environment && await pathType(environment.pythonExecutable, fsImpl) !== "file") issues.push("External Python executable is missing");
  return {
    status: issues.length ? "fail" : "pass",
    details: {
      configured: true,
      path: portablePath(configPath, env),
      environmentPath: portablePath(environment?.normalizedPath, env),
      pythonExecutable: portablePath(environment?.pythonExecutable, env),
      layout: environment?.layout || null,
      accelerator: environment?.accelerator || null,
      lastVerifiedAt: environment?.lastVerifiedAt || loaded.value?.lastVerifiedAt || null,
      issues,
    },
    effective: issues.length ? null : environment,
  };
}

export async function inspectFailureReceipt({ userData, fsImpl = fs, env = process.env } = {}) {
  const receiptPath = path.join(path.resolve(String(userData || "")), "environments", "last-failure.json");
  const loaded = await readJsonIfExists(receiptPath, fsImpl);
  if (!loaded.present) return { status: "skip", details: { present: false, path: portablePath(receiptPath, env) } };
  if (loaded.error || !loaded.value || typeof loaded.value !== "object") {
    return { status: "fail", details: { present: true, path: portablePath(receiptPath, env), issues: [loaded.error || "Failure receipt is invalid"] } };
  }
  const receipt = loaded.value;
  const serializedError = receipt.error && typeof receipt.error === "object" ? receipt.error : {};
  const commandResult = serializedError.details?.result || serializedError.details?.command || {};
  return {
    status: "fail",
    details: {
      present: true,
      path: portablePath(receiptPath, env),
      failedAt: receipt.failedAt || receipt.finishedAt || null,
      phase: receipt.phase || serializedError.details?.phase || null,
      code: receipt.code || serializedError.code || null,
      command: receipt.command || commandResult.command || null,
      exitCode: receipt.exitCode ?? commandResult.code ?? null,
      diagnostic: truncateTail(
        receipt.diagnostic
          || serializedError.message
          || commandResult.stderr
          || commandResult.stdout
          || receipt.message,
        4_000,
      ),
      selectedAccelerator: receipt.selectedAccelerator || null,
      targetPath: portablePath(receipt.targetPath, env),
    },
  };
}
