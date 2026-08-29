import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runStartupProcess } from "../startup-process.js";
import {
  redactCommandArgs,
  redactSensitiveText,
  sanitizeDiagnosticValue,
  truncateUtf8Tail,
} from "../startup-diagnostics.js";
import { detectAccelerator } from "./environment-detector.js";
import {
  BUNDLED_FFMPEG_SPEC_HASH,
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
export const DEFAULT_PYPI_MIRROR_INDEX_URL = "https://pypi.tuna.tsinghua.edu.cn/simple";
export const DEFAULT_PYPI_ALIYUN_INDEX_URL = "https://mirrors.aliyun.com/pypi/simple";
export const DEFAULT_PYPI_INDEX_URLS = Object.freeze([
  DEFAULT_PYPI_MIRROR_INDEX_URL,
  DEFAULT_PYPI_ALIYUN_INDEX_URL,
  DEFAULT_PYPI_INDEX_URL,
]);
export const DEFAULT_TORCH_INDEX_URLS = Object.freeze({
  cpu: "https://download.pytorch.org/whl/cpu",
  cu130: "https://download.pytorch.org/whl/cu130",
});
export const DEFAULT_TORCH_MIRROR_INDEX_URLS = Object.freeze({
  // TUNA mirrors the PyTorch conda channel. We still validate the requested
  // wheel before selecting it because a reachable conda directory is not
  // necessarily a pip-compatible wheel index.
  cpu: "https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/pytorch/",
  cu130: "https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/pytorch/",
});
export const DEFAULT_TORCH_ALIYUN_INDEX_URL = "https://mirrors.aliyun.com/pytorch-wheels";
export const DEFAULT_TORCH_SJTU_INDEX_URL = "https://mirror.sjtu.edu.cn/pytorch-wheels";
export const DEFAULT_TORCH_NJU_INDEX_URL = "https://mirrors.nju.edu.cn/pytorch/whl";
// Keep the source groups separate: pip's ordinary index and the PyTorch wheel
// index have different package layouts and must be selected independently.
export const DEFAULT_TORCH_INDEX_CANDIDATES = Object.freeze({
  cpu: Object.freeze([
    DEFAULT_TORCH_MIRROR_INDEX_URLS.cpu,
    DEFAULT_TORCH_ALIYUN_INDEX_URL,
    DEFAULT_TORCH_SJTU_INDEX_URL,
    DEFAULT_TORCH_NJU_INDEX_URL,
    DEFAULT_TORCH_INDEX_URLS.cpu,
  ]),
  cu130: Object.freeze([
    DEFAULT_TORCH_MIRROR_INDEX_URLS.cu130,
    DEFAULT_TORCH_ALIYUN_INDEX_URL,
    DEFAULT_TORCH_SJTU_INDEX_URL,
    DEFAULT_TORCH_NJU_INDEX_URL,
    DEFAULT_TORCH_INDEX_URLS.cu130,
  ]),
});

// PyTorch mirrors do not share one URL layout.  Keep the public candidate
// arrays backwards compatible (they are still strings), and resolve each
// candidate to an install descriptor immediately before probing/installing.
export const TORCH_SOURCE_MODES = Object.freeze({
  INDEX: "index",
  FIND_LINKS: "find-links",
  UNSUPPORTED: "unsupported",
});

const TORCH_PACKAGE_PATH_SEGMENTS = new Set(["torch", "torchvision", "torchaudio"]);

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
  if (prefix === "models" || prefix === "ffmpeg") return null;
  const remainder = normalized.slice(prefix.length + 1);
  if (!remainder) {
    throw new EnvironmentBootstrapError(`Offline payload entry is not a file: ${normalized}`, "ENVIRONMENT_PAYLOAD_FILE_INVALID");
  }
  return path.resolve(stagingPath, remainder);
}

export const BOOTSTRAP_STATUS = Object.freeze({
  IDLE: "idle",
  STAGING: "staging",
  BOOTSTRAPPING: "bootstrapping",
  PROBING: "probing",
  READY: "ready",
  DEGRADED: "degraded",
  CANCELLED: "cancelled",
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

function processResultFromError(error) {
  const diagnostic = error?.diagnostic || error?.details?.diagnostic || {};
  const numericCode = diagnostic.exitCode ?? error?.exitCode ?? error?.code;
  return normalizeProcessResult({
    success: false,
    code: Number.isFinite(Number(numericCode)) ? Number(numericCode) : 1,
    stdout: diagnostic.stdoutTail ?? diagnostic.stdout ?? error?.stdout ?? "",
    stderr:
      diagnostic.stderrTail ??
      diagnostic.stderr ??
      error?.stderr ??
      error?.userMessage ??
      error?.message ??
      String(error || "process failed"),
    diagnostic: sanitizeDiagnosticValue(diagnostic),
  });
}

const COMMAND_LABELS = Object.freeze({
  "create-venv": "创建项目虚拟环境",
  "upgrade-pip": "更新 pip",
  "install-requirements": "安装 Python 与 PyTorch 依赖",
  "inspect-sam3-wheel": "校验 SAM3 本地 wheel",
  "install-sam3-wheel": "安装 SAM3 本地 wheel",
  "relocate-offline-runtime": "调整离线运行环境",
});

function commandFailureSummary(result) {
  const lines = `${result?.stderr || ""}\n${result?.stdout || ""}`
    .split(/\r?\n/u)
    .map((line) => redactSensitiveText(line.trim()))
    .filter(Boolean);
  return (
    lines.find((line) => /(?:^|\b)(?:ERROR|FATAL)\b|No matching distribution|Could not find|certificate verify failed|timed out|connection (?:reset|refused)/iu.test(line)) ||
    lines.at(-1) ||
    "请查看验收报告中的命令诊断。"
  );
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
    return value.path || value.pythonPath || value.pythonExecutable || value.executable || "";
  }
  return "";
}

function parsePythonVersionOutput(value) {
  const match = String(value ?? "").match(/(?:Python\s+)?(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? null : Number(match[3]),
    text: `${match[1]}.${match[2]}${match[3] === undefined ? "" : `.${match[3]}`}`,
  };
}

function matchesPythonMajorMinor(actual, expected) {
  const actualVersion = parsePythonVersionOutput(actual);
  const expectedVersion = parsePythonVersionOutput(expected);
  return Boolean(
    actualVersion
    && expectedVersion
    && actualVersion.major === expectedVersion.major
    && actualVersion.minor === expectedVersion.minor,
  );
}

function normalizeDistributionName(value) {
  return String(value || "").trim().toLowerCase().replace(/[-_.]+/gu, "-");
}

function parseLockedRequirements(value) {
  return String(value || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("-"))
    .map((line) => line.split(";", 1)[0].trim())
    .map((line) => {
      const match = line.match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?==([^\s]+)$/u);
      return match
        ? { name: normalizeDistributionName(match[1]), version: match[2] }
        : null;
    })
    .filter(Boolean);
}

function normalizeSourceUrl(value) {
  if (value && typeof value === "object") {
    return String(value.url ?? value.baseUrl ?? value.indexUrl ?? value.href ?? "").trim();
  }
  return String(value ?? "").trim();
}

function normalizeSourceCandidates(values = []) {
  const list = Array.isArray(values) ? values : [values];
  const seen = new Set();
  const result = [];
  for (const value of list) {
    const url = normalizeSourceUrl(value);
    const key = url.replace(/\/+$/u, "").toLowerCase();
    if (!url || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function trimSourceUrl(value) {
  return normalizeSourceUrl(value).replace(/\/+$/u, "");
}

function hasSourceVariant(url, accelerator) {
  const normalized = trimSourceUrl(url).toLowerCase();
  const variant = String(accelerator || "").trim().toLowerCase();
  return Boolean(variant && new RegExp(`(?:^|/)${variant}(?:/|$)`, "u").test(normalized));
}

function normalizeTorchSourceRoot(url) {
  const raw = trimSourceUrl(url);
  if (!raw) return raw;

  // Mirrors are often documented as a package-specific URL, for example
  // `/pytorch/whl/cu130/torch` or `/pytorch/whl/torch/cu130`.  pip needs the
  // variant root and appends the package name itself, so remove package path
  // segments while preserving the rest of the URL.
  try {
    const parsed = new URL(raw);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const filtered = segments.filter(
      (segment) => !TORCH_PACKAGE_PATH_SEGMENTS.has(String(segment).toLowerCase()),
    );
    parsed.pathname = filtered.length ? `/${filtered.join("/")}` : "/";
    return trimSourceUrl(parsed.toString());
  } catch {
    // Keep support for test/custom relative URLs without letting malformed
    // input break source diagnostics.
    return raw.replace(/\/(?:torch|torchvision|torchaudio)(?=\/|$)/giu, "") || raw;
  }
}

function appendSourceVariant(url, accelerator) {
  const base = normalizeTorchSourceRoot(url);
  const variant = String(accelerator || "").trim().toLowerCase();
  if (!base || !variant || hasSourceVariant(base, variant)) return base;
  return `${base}/${variant}`;
}

function inferTorchSourceMode(url, suppliedMode) {
  const explicit = String(suppliedMode || "").trim().toLowerCase();
  if ([TORCH_SOURCE_MODES.INDEX, TORCH_SOURCE_MODES.FIND_LINKS, TORCH_SOURCE_MODES.UNSUPPORTED].includes(explicit)) {
    return explicit;
  }
  const normalized = trimSourceUrl(url).toLowerCase();
  if (normalized.includes("anaconda/cloud/pytorch")) return TORCH_SOURCE_MODES.UNSUPPORTED;
  if (normalized.includes("mirrors.aliyun.com/pytorch-wheels")) return TORCH_SOURCE_MODES.FIND_LINKS;
  return TORCH_SOURCE_MODES.INDEX;
}

/**
 * Resolve a legacy string or an explicit source object into the URL that pip
 * actually understands.  `url` remains the user/configuration value for
 * diagnostics; `installUrl`/`probeUrl` carry variant-specific paths.
 */
function normalizeSourceCandidate(value, { category = "", accelerator = "", packageName = "" } = {}) {
  const sourceObject = value && typeof value === "object" ? value : {};
  const url = normalizeSourceUrl(value);
  const torchSource = String(category || "").startsWith("torch-");
  if (!torchSource) {
    const installUrl = sourceObject.installUrl || sourceObject.probeUrl || url;
    return {
      url,
      mode: TORCH_SOURCE_MODES.INDEX,
      installUrl: trimSourceUrl(installUrl),
      probeUrl: trimSourceUrl(sourceObject.probeUrl || installUrl),
      packageName,
    };
  }

  const mode = inferTorchSourceMode(url, sourceObject.mode || sourceObject.installMode);
  const configuredInstallUrl = sourceObject.installUrl || sourceObject.variantUrl;
  const variantUrl = configuredInstallUrl
    ? normalizeTorchSourceRoot(configuredInstallUrl)
    : mode === TORCH_SOURCE_MODES.UNSUPPORTED
      ? normalizeTorchSourceRoot(url)
      : appendSourceVariant(url, accelerator);
  const installUrl = trimSourceUrl(variantUrl);
  const probeUrl = trimSourceUrl(sourceObject.probeUrl || installUrl);
  return {
    url,
    mode,
    installUrl,
    probeUrl,
    packageName,
    variant: String(accelerator || "").trim().toLowerCase(),
  };
}

function sourcePackageEndpoint(baseUrl, packageName) {
  const base = trimSourceUrl(baseUrl);
  const normalizedName = normalizeDistributionName(packageName);
  if (!normalizedName) return `${base}/`;
  // A package-specific PEP 503 URL is already complete.  This matters for
  // custom mirrors configured with .../torch/ or .../torchvision/ directly.
  const lastSegment = base.split("/").filter(Boolean).at(-1)?.toLowerCase();
  return lastSegment === normalizedName ? `${base}/` : `${base}/${encodeURIComponent(normalizedName)}/`;
}

function decodeSourceBody(value) {
  return String(value || "")
    .replace(/&#x2b;|&#43;|%2b/giu, "+")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&#x2f;|%2f/giu, "/");
}

function sourceBodyContainsVersion(body, version) {
  const normalizedBody = decodeSourceBody(body).toLowerCase();
  const normalizedVersion = decodeSourceBody(version).trim().toLowerCase();
  if (!normalizedVersion || normalizedVersion === "*") return true;
  return normalizedBody.includes(normalizedVersion);
}

function sourceBodyContainsPipWheel(body) {
  return /\.whl(?:[#"'<>\s]|$)/iu.test(decodeSourceBody(body));
}

function sourceSupportsTorchVariant(body, category, accelerator, packageName, version) {
  if (!String(category || "").startsWith("torch-")) return true;
  const normalizedBody = decodeSourceBody(body).toLowerCase();
  if (!sourceBodyContainsPipWheel(normalizedBody)) return false;
  const normalizedPackage = normalizeDistributionName(packageName);
  const normalizedVersion = decodeSourceBody(version).trim().toLowerCase();
  const links = normalizedBody.match(/[^\s"'<>]+\.whl(?:#[^\s"'<>]*)?/giu) || [];
  const matchingPackage = links.filter((link) => {
    const fileName = link.split(/[\\/]/u).at(-1) || link;
    const packagePrefix = fileName.toLowerCase().startsWith(`${normalizedPackage}-`);
    const versionMatch = !normalizedVersion || normalizedVersion === "*" || fileName.toLowerCase().includes(normalizedVersion);
    return packagePrefix && versionMatch;
  });
  if (matchingPackage.length === 0) return false;
  if (category !== "torch-cuda" && category !== "torch-cpu") return true;
  const variant = String(accelerator || "").trim().toLowerCase();
  return !variant || matchingPackage.some((link) => link.toLowerCase().includes(variant));
}

function combineAbortSignals(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("source probe timed out")),
    Math.max(500, Number(timeoutMs) || 8000),
  );
  timeout.unref?.();
  const relay = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) relay();
  else parentSignal?.addEventListener?.("abort", relay, { once: true });
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      parentSignal?.removeEventListener?.("abort", relay);
    },
  };
}

/**
 * Probe one package source without changing the target environment.
 * `packageAvailable` deliberately checks the requested version as well as
 * HTTP reachability; this prevents a conda directory or a CPU-only index from
 * being selected for a CUDA wheel transaction.
 */
export async function probePackageSource(
  sourceUrl,
  {
    packageName = "",
    version = "",
    category = "",
    accelerator = "",
    timeoutMs = 8000,
    signal,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  const candidate = normalizeSourceCandidate(sourceUrl, { category, accelerator, packageName });
  const url = candidate.url;
  const probeUrl = candidate.probeUrl || url;
  const probeEndpoint = candidate.mode === TORCH_SOURCE_MODES.FIND_LINKS
    || candidate.mode === TORCH_SOURCE_MODES.UNSUPPORTED
    ? `${trimSourceUrl(probeUrl)}/`
    : sourcePackageEndpoint(probeUrl, packageName);
  const startedAt = Date.now();
  const result = {
    url,
    endpoint: probeEndpoint,
    probeUrl,
    installUrl: candidate.installUrl || probeUrl,
    mode: candidate.mode,
    latencyMs: null,
    status: null,
    reachable: false,
    packageAvailable: false,
    pipWheelAvailable: null,
    acceleratorAvailable: null,
    usable: false,
    error: "",
  };
  if (!url) {
    result.error = "source URL is empty";
    return result;
  }
  if (typeof fetchImpl !== "function") {
    result.error = "fetch is unavailable";
    return result;
  }
  const request = combineAbortSignals(signal, timeoutMs);
  try {
    const response = await fetchImpl(result.endpoint, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "text/html, application/vnd.pypi.simple.v1+json" },
      signal: request.signal,
    });
    result.status = Number(response?.status || 0) || null;
    result.reachable = response?.ok == null
      ? Boolean(result.status && result.status >= 200 && result.status < 400)
      : Boolean(response.ok);
    const body = result.reachable && typeof response?.text === "function"
      ? await response.text()
      : "";
    const torchSource = String(category || "").startsWith("torch-");
    result.pipWheelAvailable = torchSource ? sourceBodyContainsPipWheel(body) : null;
    result.acceleratorAvailable = category === "torch-cuda" ? (
      !accelerator || decodeSourceBody(body).toLowerCase().includes(String(accelerator).toLowerCase())
    ) : null;
    const versionAvailable = torchSource
      ? sourceSupportsTorchVariant(body, category, accelerator, packageName, version)
      : sourceBodyContainsVersion(body, version);
    result.packageAvailable = result.reachable && versionAvailable && (
      !torchSource || candidate.mode !== TORCH_SOURCE_MODES.UNSUPPORTED
    );
    result.usable = result.reachable && result.packageAvailable;
    if (result.reachable && !result.packageAvailable) {
      result.error = torchSource
        ? `target ${packageName}==${version} was not found in a compatible pip wheel index`
        : `target ${packageName}==${version} was not found`;
    }
    if (!result.reachable) result.error = `HTTP ${result.status || 0}`;
  } catch (error) {
    result.error = error?.message || String(error);
  } finally {
    request.cleanup();
    result.latencyMs = Math.max(0, Date.now() - startedAt);
  }
  return result;
}

function makeOperationId(now) {
  return `env-${Number(now())}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
}

function cancellationError(signal) {
  const reason = signal?.reason;
  if (reason instanceof EnvironmentBootstrapError) return reason;
  return new EnvironmentBootstrapError(
    reason?.message || "运行环境准备已取消。",
    "ENVIRONMENT_PREPARATION_CANCELLED",
    { cancelled: true },
  );
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw cancellationError(signal);
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
  try {
    if (typeof runner === "function") return normalizeProcessResult(await runner(command, args, options));
    if (runner && typeof runner.run === "function") {
      return normalizeProcessResult(await runner.run(command, args, options));
    }
    return defaultCommandRunner(command, args, options);
  } catch (error) {
    return processResultFromError(error);
  }
}

function mergeSources(base, overrides = {}, accelerator) {
  const explicitPipUrl = normalizeSourceUrl(
    overrides.pipIndexUrl ?? base.pipIndexUrl ?? base.pythonIndexUrl,
  );
  const explicitTorchUrl = normalizeSourceUrl(
    overrides.torchIndexUrl ?? base.torchIndexUrl,
  );
  const pipFallback = explicitPipUrl ? [explicitPipUrl] : DEFAULT_PYPI_INDEX_URLS;
  const torchFallback = explicitTorchUrl
    ? [explicitTorchUrl]
    : (DEFAULT_TORCH_INDEX_CANDIDATES[accelerator] || [DEFAULT_TORCH_INDEX_URLS[accelerator]]);
  const rawPipCandidates = overrides.pipIndexCandidates !== undefined
    ? overrides.pipIndexCandidates
    : explicitPipUrl
      ? [explicitPipUrl]
      : base.pipIndexCandidates !== undefined
        ? base.pipIndexCandidates
        : pipFallback;
  const rawTorchCandidates = overrides.torchIndexCandidates !== undefined
    ? overrides.torchIndexCandidates
    : explicitTorchUrl
      ? [explicitTorchUrl]
      : base.torchIndexCandidates !== undefined
        ? base.torchIndexCandidates
        : torchFallback;
  const pipIndexCandidates = normalizeSourceCandidates(rawPipCandidates).length > 0
    ? normalizeSourceCandidates(rawPipCandidates)
    : normalizeSourceCandidates(pipFallback);
  const torchIndexCandidates = normalizeSourceCandidates(rawTorchCandidates).length > 0
    ? normalizeSourceCandidates(rawTorchCandidates)
    : normalizeSourceCandidates(torchFallback);
  const merged = {
    ...base,
    ...overrides,
    pythonIndexUrl: overrides.pythonIndexUrl || base.pythonIndexUrl || DEFAULT_PYPI_INDEX_URL,
    pipIndexUrl: explicitPipUrl || pipIndexCandidates[0] || DEFAULT_PYPI_INDEX_URL,
    torchIndexUrl: explicitTorchUrl || torchIndexCandidates[0] || DEFAULT_TORCH_INDEX_URLS[accelerator],
    pipIndexCandidates,
    torchIndexCandidates,
    extraIndexUrl: overrides.extraIndexUrl || base.extraIndexUrl || "",
    pythonInstallerUrl: overrides.pythonInstallerUrl || base.pythonInstallerUrl || DEFAULT_PYTHON_INSTALLER_URL,
  };
  if (!merged.pipIndexUrl) merged.pipIndexUrl = merged.pipIndexCandidates[0] || merged.pythonIndexUrl;
  if (!merged.torchIndexUrl) merged.torchIndexUrl = merged.torchIndexCandidates[0] || DEFAULT_TORCH_INDEX_URLS[accelerator];
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
    sam3WheelPath = "",
    sam3WheelHash = "",
    ffmpegSourcePath,
    ffmpegHash,
    pythonExecutable = "python",
    pythonInstaller,
    commandRunner,
    acceleratorRunner,
    sourceConfig = {},
    sourceProbe = probePackageSource,
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
    this.sam3WheelPath = sam3WheelPath || "";
    this.sam3WheelHash = sam3WheelHash || "";
    this.ffmpegSourcePath = ffmpegSourcePath || "";
    this.ffmpegHash = ffmpegHash || "";
    this.pythonExecutable = pythonExecutable || "python";
    this.pythonInstaller = pythonInstaller;
    this.commandRunner = commandRunner;
    this.acceleratorRunner = acceleratorRunner;
    this.sourceConfig = { ...sourceConfig };
    this.sourceProbe = typeof sourceProbe === "function" ? sourceProbe : probePackageSource;
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
    this.failureReceiptPath = path.join(this.rootDir, "environments", "last-failure.json");
    this.stagingRoot = path.join(this.rootDir, "environments", ".staging");
    this.state = {
      status: BOOTSTRAP_STATUS.IDLE,
      selectedAccelerator: null,
      selectionReason: null,
      operationId: null,
      stagingPath: null,
      activePath: null,
      specHash: null,
      sourceSelection: null,
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

  async _clearFailureReceipt() {
    await this.fs.rm(this.failureReceiptPath, { force: true }).catch(() => {});
  }

  async _writeFailureReceipt({ error, progress, targetPath, operationId }) {
    const receipt = sanitizeDiagnosticValue({
      schemaVersion: ENVIRONMENT_BOOTSTRAP_SCHEMA,
      appVersion: this.appVersion,
      platformArch: this.platformArch,
      operationId,
      failedAt: new Date(this.now()).toISOString(),
      phase: progress?.phase || null,
      targetPath: targetPath || null,
      selectedAccelerator: this.state.selectedAccelerator,
      selectionReason: this.state.selectionReason,
      error: serializeError(error),
    });
    await this._writeJsonAtomic(this.failureReceiptPath, receipt, operationId || "failure");
    return receipt;
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
    if (!hasRuntime) throw new EnvironmentBootstrapError("Offline payload runtime files are required", "ENVIRONMENT_PAYLOAD_RUNTIME_MISSING");
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
      const requirementsLockHash = normalizeHash(
        manifest.requirementsLockHash || requirementsEntry?.sha256,
        "requirementsLockHash",
      );
      spec = buildEnvironmentSpec({
        appVersion: this.appVersion,
        pythonVersion: manifest.pythonVersion || this.pythonVersion,
        accelerator: variant,
        requirementsLockHash,
        ffmpegHash: manifest.ffmpegHash || BUNDLED_FFMPEG_SPEC_HASH,
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

  async _offlineRuntimePaths(stagingPath) {
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
    const ffmpegResource = await this._inspectBundledFfmpeg();
    return {
      pythonExecutable,
      ffmpegPath: ffmpegResource.path,
      ffmpegResource,
      condaUnpackExecutable,
    };
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
    if (!this._isSafeRelativePointerPath(pointer.path)) return null;
    const activePath = pointer.path ? path.resolve(this.rootDir, pointer.path) : "";
    if (!activePath || !this._isWithin(activePath, this.environmentsRoot)) return null;
    return { ...pointer, absolutePath: activePath };
  }

  _isWithin(candidate, root) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === "" || (relative && !relative.startsWith(`..${path.sep}`) && relative !== "..");
  }

  _isSafeRelativePointerPath(value) {
    if (typeof value !== "string" || !value.trim()) return false;
    const normalized = value.replace(/\\/g, "/");
    if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || normalized.startsWith("/") || normalized.includes(".staging")) return false;
    const segments = normalized.split("/");
    return !segments.some((segment) => !segment || segment === "." || segment === "..");
  }

  _isSafePythonPointerPath(value) {
    return value == null || this._isSafeRelativePointerPath(value);
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

  async _isCompatiblePython(pythonExecutable, signal) {
    try {
      await this.fs.access(pythonExecutable);
    } catch {
      return false;
    }
    const result = await invokeCommandRunner(this.commandRunner, pythonExecutable, ["--version"], {
      cwd: this.state.stagingPath || this.rootDir,
      env: this.baseEnv,
      signal,
      timeoutMs: Math.min(this.timeoutMs, 30_000),
      stage: "environment-bootstrap-python-reuse",
    });
    return result.success && matchesPythonMajorMinor(`${result.stdout}\n${result.stderr}`, this.pythonVersion);
  }

  async _hasUsablePip(pythonExecutable, signal) {
    const result = await invokeCommandRunner(this.commandRunner, pythonExecutable, ["-m", "pip", "--version"], {
      cwd: this.state.stagingPath || this.rootDir,
      env: this.baseEnv,
      signal,
      timeoutMs: Math.min(this.timeoutMs, 30_000),
      stage: "environment-bootstrap-pip-check",
    });
    return result.success;
  }

  async _lockedRequirementsSatisfied(pythonExecutable, requirementsPath, signal) {
    let expected;
    try {
      expected = parseLockedRequirements(await this.fs.readFile(requirementsPath, "utf8"));
    } catch {
      return false;
    }
    if (expected.length === 0) return false;
    const listResult = await invokeCommandRunner(
      this.commandRunner,
      pythonExecutable,
      ["-m", "pip", "list", "--format=json", "--disable-pip-version-check"],
      {
        cwd: this.state.stagingPath || this.rootDir,
        env: this.baseEnv,
        signal,
        timeoutMs: Math.min(this.timeoutMs, 60_000),
        stage: "environment-bootstrap-dependency-check",
      },
    );
    if (!listResult.success) return false;
    let installed;
    try {
      installed = new Map(JSON.parse(listResult.stdout).map((entry) => [
        normalizeDistributionName(entry.name),
        String(entry.version || ""),
      ]));
    } catch {
      return false;
    }
    if (!expected.every((entry) => installed.get(entry.name) === entry.version)) return false;
    const checkResult = await invokeCommandRunner(
      this.commandRunner,
      pythonExecutable,
      ["-m", "pip", "check", "--disable-pip-version-check"],
      {
        cwd: this.state.stagingPath || this.rootDir,
        env: this.baseEnv,
        signal,
        timeoutMs: Math.min(this.timeoutMs, 60_000),
        stage: "environment-bootstrap-dependency-consistency",
      },
    );
    return checkResult.success;
  }

  async _run(command, args, label, signal, output = {}) {
    throwIfAborted(signal);
    const result = await invokeCommandRunner(this.commandRunner, command, args, {
      cwd: this.state.stagingPath || this.rootDir,
      env: this.baseEnv,
      signal,
      timeoutMs: this.timeoutMs,
      stage: `environment-bootstrap-${label}`,
      onStdout: output.onStdout,
      onStderr: output.onStderr,
    });
    throwIfAborted(signal);
    const record = {
      label,
      command: redactSensitiveText(command),
      args: redactCommandArgs(args),
      code: result.code,
      stdout: redactSensitiveText(truncateUtf8Tail(result.stdout)),
      stderr: redactSensitiveText(truncateUtf8Tail(result.stderr)),
      diagnostic: sanitizeDiagnosticValue(result.diagnostic || null),
    };
    const lastStep = this.state.steps.at(-1);
    if (lastStep) lastStep.command = record;
    if (!result.success) {
      throw new EnvironmentBootstrapError(
        `${COMMAND_LABELS[label] || label}失败（退出码 ${record.code}）：${commandFailureSummary(record)}`,
        "ENVIRONMENT_COMMAND_FAILED",
        { phase: label, label, command: record.command, args: record.args, result: record },
      );
    }
    return result;
  }

  async _discoverPython(signal, sources = this.sourceConfig, onProgress) {
    throwIfAborted(signal);
    const discoveries = [];
    const verifyCandidate = async (candidate, stage) => {
      const result = await invokeCommandRunner(this.commandRunner, candidate, ["--version"], {
        cwd: this.rootDir,
        env: this.baseEnv,
        signal,
        timeoutMs: Math.min(this.timeoutMs, 30_000),
        stage,
      });
      const versionOutput = `${result.stdout || ""}\n${result.stderr || ""}`;
      const version = parsePythonVersionOutput(versionOutput);
      discoveries.push({
        candidate: redactSensitiveText(candidate),
        version: version?.text || null,
        usable: Boolean(result.success),
        compatible: Boolean(result.success && matchesPythonMajorMinor(versionOutput, this.pythonVersion)),
      });
      return discoveries.at(-1).compatible;
    };
    const configured = this.pythonExecutable;
    const candidates = Array.isArray(configured) ? configured : [configured];
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        if (await verifyCandidate(candidate, "environment-bootstrap-python-discover")) return String(candidate);
      } catch {
        throwIfAborted(signal);
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
      throwIfAborted(signal);
      if (installedPath && await verifyCandidate(installedPath, "environment-bootstrap-python-install-verify")) {
        return String(installedPath);
      }
    } else if (this.pythonInstaller && typeof this.pythonInstaller.install === "function") {
      const installed = await this.pythonInstaller.install({
        version: this.pythonVersion,
        url: sources.pythonInstallerUrl || DEFAULT_PYTHON_INSTALLER_URL,
        rootDir: this.rootDir,
        signal,
        onProgress,
      });
      const installedPath = resolveInstallerPath(installed);
      throwIfAborted(signal);
      if (installedPath && await verifyCandidate(installedPath, "environment-bootstrap-python-install-verify")) {
        return String(installedPath);
      }
    }
    const expected = parsePythonVersionOutput(this.pythonVersion);
    const expectedFamily = expected ? `${expected.major}.${expected.minor}.x` : this.pythonVersion;
    const found = discoveries.filter((entry) => entry.version).map((entry) => entry.version).join(", ");
    throw new EnvironmentBootstrapError(
      `No supported Python ${expectedFamily} interpreter was found${found ? `; detected incompatible version(s): ${found}` : ""}`,
      "ENVIRONMENT_PYTHON_NOT_FOUND",
      { expectedVersion: expectedFamily, discoveries },
    );
  }

  async _inspectBundledFfmpeg() {
    const source = this.ffmpegSourcePath
      ? requiredPath(this.ffmpegSourcePath, "ffmpegSourcePath")
      : path.join(
        this.rootDir,
        ".missing-bundled-ffmpeg",
        fileNameForFfmpeg(this.ffmpegSourcePath, this.platform),
      );
    const base = {
      path: source,
      root: path.dirname(source),
      hash: BUNDLED_FFMPEG_SPEC_HASH,
      source: "bundled",
      available: false,
      integrityOk: false,
      expectedHash: null,
      actualHash: null,
      error: null,
    };
    if (!this.ffmpegSourcePath) {
      return {
        ...base,
        error: serializeError(new EnvironmentBootstrapError(
          "应用内置 FFmpeg 路径未配置。",
          "ENVIRONMENT_FFMPEG_SOURCE_REQUIRED",
          { filePath: source },
        )),
      };
    }

    let expectedHash = null;
    try {
      expectedHash = this.ffmpegHash ? normalizeHash(this.ffmpegHash, "ffmpegHash") : null;
    } catch (error) {
      return { ...base, error: serializeError(error) };
    }

    let actualHash;
    try {
      actualHash = await this._fileHash(source);
    } catch (error) {
      return {
        ...base,
        expectedHash,
        error: serializeError(new EnvironmentBootstrapError(
          `应用内置 FFmpeg 不可用：${error.message}`,
          "ENVIRONMENT_FFMPEG_UNAVAILABLE",
          { filePath: source, cause: error?.code || null },
        )),
      };
    }
    if (expectedHash && actualHash !== expectedHash) {
      return {
        ...base,
        expectedHash,
        actualHash,
        error: serializeError(new EnvironmentBootstrapError(
          "应用内置 FFmpeg 完整性校验失败。",
          "ENVIRONMENT_HASH_MISMATCH",
          { expected: expectedHash, actual: actualHash, filePath: source },
        )),
      };
    }
    return {
      ...base,
      available: true,
      integrityOk: true,
      expectedHash,
      actualHash,
    };
  }

 _applyBundledFfmpegState(health, resource) {
   if (resource?.available !== false) return health;
   const coreSuccess = health?.success !== false;
   const resourceMessage = resource?.error?.message || "应用内置 FFmpeg 不可用。";
   const warning = resourceMessage.startsWith("FFmpeg:")
     ? resourceMessage
     : `FFmpeg: ${resourceMessage}`;
   return {
     ...(health || {}),
     success: coreSuccess,
     degraded: coreSuccess,
     ffmpeg: {
       ...(health?.ffmpeg || {}),
       ok: false,
       path: resource?.path || health?.ffmpeg?.path || "",
       error: warning,
       resourceError: clone(resource?.error || null),
     },
     warnings: [...new Set([...(health?.warnings || []), warning])],
     capabilities: {
       ...(health?.capabilities || {}),
       core: coreSuccess,
       image: coreSuccess,
       video: false,
       ffmpeg: false,
     },
   };
 }

  async _inspectSam3Wheel() {
    const filePath = String(this.sam3WheelPath || "").trim();
    if (!filePath) {
      throw new EnvironmentBootstrapError(
        "CUDA 环境缺少随包 SAM3 wheel。",
        "ENVIRONMENT_SAM3_WHEEL_UNAVAILABLE",
      );
    }
    let stat;
    try {
      stat = await this.fs.stat(filePath);
    } catch (error) {
      throw new EnvironmentBootstrapError(
        `随包 SAM3 wheel 不可用：${error.message}`,
        "ENVIRONMENT_SAM3_WHEEL_UNAVAILABLE",
        { filePath },
      );
    }
    if (!stat.isFile?.() || !/^sam3-.+\.whl$/iu.test(path.basename(filePath))) {
      throw new EnvironmentBootstrapError(
        "随包 SAM3 wheel 路径无效。",
        "ENVIRONMENT_SAM3_WHEEL_INVALID",
        { filePath },
      );
    }
    const actualHash = await this._fileHash(filePath);
    if (this.sam3WheelHash) {
      const expectedHash = normalizeHash(this.sam3WheelHash, "sam3WheelHash");
      if (actualHash !== expectedHash) {
        throw new EnvironmentBootstrapError(
          "随包 SAM3 wheel 完整性校验失败。",
          "ENVIRONMENT_SAM3_WHEEL_HASH_MISMATCH",
          { filePath, expectedHash, actualHash },
        );
      }
      return { path: filePath, hash: actualHash, expectedHash };
    }
    return { path: filePath, hash: actualHash, expectedHash: null };
  }

  async _installSam3Wheel(pythonExecutable, wheel, signal) {
    if (!wheel?.path) {
      throw new EnvironmentBootstrapError(
        "CUDA 环境缺少随包 SAM3 wheel。",
        "ENVIRONMENT_SAM3_WHEEL_UNAVAILABLE",
      );
    }
    await this._step("install-sam3-wheel", () => this._run(
      pythonExecutable,
      ["-m", "pip", "install", "--no-deps", "--force-reinstall", wheel.path],
      "install-sam3-wheel",
      signal,
    ));
  }

  _sourceConfig(accelerator, sourceOverrides) {
    return mergeSources(
      { ...this.sourceConfig },
      sourceOverrides || {},
      accelerator,
    );
  }

  async _selectSources(accelerator, sources, requirementsLockPath, signal) {
    let lockedRequirements = [];
    try {
      lockedRequirements = parseLockedRequirements(await this.fs.readFile(requirementsLockPath, "utf8"));
    } catch {
      // The regular requirements hash/path validation reports a more useful
      // error later; use representative package names for source diagnostics.
    }
    const torchRequirement = lockedRequirements.find((entry) => entry.name === "torch") || {
      name: "torch",
      version: "*",
    };
    const ordinaryRequirement = lockedRequirements.find(
      (entry) => !["torch", "torchvision", "torchaudio"].includes(entry.name),
    ) || { name: "pip", version: "*" };

    const probeCategory = async ({ category, label, candidates, requirement }) => {
      const normalizedCandidates = normalizeSourceCandidates(candidates)
        .map((candidate) => normalizeSourceCandidate(candidate, {
          category,
          accelerator,
          packageName: requirement.name,
        }));
      const diagnostics = await Promise.all(normalizedCandidates.map(async (candidate) => {
        try {
          const raw = await this.sourceProbe(candidate.url, {
            category,
            accelerator,
            packageName: requirement.name,
            version: requirement.version,
            source: candidate,
            mode: candidate.mode,
            probeUrl: candidate.probeUrl,
            installUrl: candidate.installUrl,
            signal,
            timeoutMs: Math.min(this.timeoutMs, 12_000),
          });
          const normalized = raw && typeof raw === "object" ? { ...raw } : {};
          const reachable = normalized.reachable ?? normalized.success ?? false;
          const packageAvailable = normalized.packageAvailable
            ?? normalized.resolvable
            ?? normalized.success
            ?? false;
          return {
            url: candidate.url,
            endpoint: normalized.endpoint || (
              candidate.mode === TORCH_SOURCE_MODES.FIND_LINKS || candidate.mode === TORCH_SOURCE_MODES.UNSUPPORTED
                ? `${trimSourceUrl(candidate.probeUrl)}/`
                : sourcePackageEndpoint(candidate.probeUrl, requirement.name)
            ),
            probeUrl: normalized.probeUrl || candidate.probeUrl,
            installUrl: normalized.installUrl || candidate.installUrl,
            mode: normalized.mode || candidate.mode,
            latencyMs: Number.isFinite(Number(normalized.latencyMs))
              ? Number(normalized.latencyMs)
              : Number.POSITIVE_INFINITY,
            status: normalized.status ?? null,
            reachable: Boolean(reachable),
            packageAvailable: Boolean(packageAvailable),
            usable: normalized.usable == null
              ? Boolean(reachable && packageAvailable)
              : Boolean(normalized.usable),
            error: String(normalized.error || ""),
          };
        } catch (error) {
          return {
            url: candidate.url,
            endpoint: candidate.mode === TORCH_SOURCE_MODES.FIND_LINKS || candidate.mode === TORCH_SOURCE_MODES.UNSUPPORTED
              ? `${trimSourceUrl(candidate.probeUrl)}/`
              : sourcePackageEndpoint(candidate.probeUrl, requirement.name),
            probeUrl: candidate.probeUrl,
            installUrl: candidate.installUrl,
            mode: candidate.mode,
            latencyMs: Number.POSITIVE_INFINITY,
            status: null,
            reachable: false,
            packageAvailable: false,
            usable: false,
            error: error?.message || String(error),
          };
        }
      }));
      throwIfAborted(signal);
      const usable = diagnostics
        .filter((entry) => entry.usable)
        .sort((left, right) => left.latencyMs - right.latencyMs);
      if (usable.length === 0) {
        const unreachableSources = diagnostics.filter((entry) => !entry.reachable);
        const incompatibleSources = diagnostics.filter((entry) => entry.reachable && !entry.packageAvailable);
        const sourceText = diagnostics
          .map((entry) => {
            const status = !entry.reachable
              ? "不可达"
              : entry.mode === TORCH_SOURCE_MODES.UNSUPPORTED
                ? "可访问但不是 pip wheel 源"
                : "可访问但未找到目标依赖";
            return `${entry.url}（${status}）`;
          })
          .join("；");
        const packageText = requirement.version === "*"
          ? requirement.name
          : `${requirement.name}==${requirement.version}`;
        const sourceCountText = diagnostics.length === 2
          ? "检测到的两个源"
          : `检测到的 ${diagnostics.length} 个源`;
        throw new EnvironmentBootstrapError(
          `${label}不可用：${sourceCountText}均不可达或无法解析目标依赖（${packageText}）：${sourceText || "未配置"}`,
          "ENVIRONMENT_SOURCE_UNAVAILABLE",
          {
            category,
            accelerator,
            package: packageText,
            candidates: diagnostics,
            unavailableSources: diagnostics.map((entry) => entry.url),
            unreachableSources: unreachableSources.map((entry) => entry.url),
            incompatibleSources: incompatibleSources.map((entry) => entry.url),
          },
        );
      }
      return {
        selected: usable[0],
        candidates: diagnostics,
      };
    };

    const [pip, torch] = await Promise.all([
      probeCategory({
        category: "python",
        label: "普通 Python 依赖下载源",
        candidates: sources.pipIndexCandidates,
        requirement: ordinaryRequirement,
      }),
      probeCategory({
        category: accelerator === "cu130" ? "torch-cuda" : "torch-cpu",
        label: accelerator === "cu130" ? "PyTorch CUDA 专用源" : "PyTorch CPU 专用源",
        candidates: sources.torchIndexCandidates,
        requirement: torchRequirement,
      }),
    ]);
    return {
      sources: {
        ...sources,
        pipIndexUrl: pip.selected.installUrl || pip.selected.url,
        torchIndexUrl: torch.selected.installUrl || torch.selected.url,
        torchInstallUrl: torch.selected.installUrl || torch.selected.url,
        torchInstallMode: torch.selected.mode || TORCH_SOURCE_MODES.INDEX,
      },
      selection: {
        python: pip,
        torch,
      },
    };
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
    throwIfAborted(signal);
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

  async cleanupStaleStaging() {
    const removed = [];
    const entries = await this.fs.readdir(this.stagingRoot, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory?.()) continue;
      const target = path.join(this.stagingRoot, entry.name);
      await this.fs.rm(target, { recursive: true, force: true });
      removed.push(target);
    }
    return { success: true, removed, count: removed.length };
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
      if (patch?.logOnly) {
        emitProgress(onProgress, patch);
        return;
      }
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
      sourceSelection: null,
      error: null,
      steps: [],
      startedAt,
      finishedAt: null,
    };
    reportProgress(lastProgress);
    let stagingPath = null;
    try {
      throwIfAborted(signal);
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
      const sam3Wheel = selectedAccelerator === "cu130"
        ? await this._step("inspect-sam3-wheel", () => this._inspectSam3Wheel())
        : null;
      const ffmpeg = await this._step("inspect-ffmpeg", () => this._inspectBundledFfmpeg());
      const spec = buildEnvironmentSpec({
        appVersion: this.appVersion,
        pythonVersion: this.pythonVersion,
        accelerator: selectedAccelerator,
        requirementsLockHash,
        ffmpegHash: ffmpeg.hash,
        sam3WheelHash: sam3Wheel?.hash,
      });
      this.state.specHash = spec.specHash;
      reportProgress({ phase: "resolve-environment", percent: 10, message: "正在检查可复用的运行环境。" });
      let previous = await this._activePointer();
      const targetPath = path.join(this.environmentsRoot, selectedAccelerator, spec.specHash);
      this.state.targetPath = targetPath;
      reportProgress({
        phase: "environment-path",
        percent: 10,
        message: `运行环境将创建在：${targetPath}`,
        environmentPath: targetPath,
      });
      if (previous?.specHash === spec.specHash && previous?.absolutePath === targetPath) {
        const activePython = previous?.pythonExecutableRelative && this._isSafePythonPointerPath(previous.pythonExecutableRelative)
          ? path.resolve(targetPath, previous.pythonExecutableRelative)
          : path.join(
            targetPath,
            "venv",
            ...(this.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]),
          );
        const probedHealth = await this._step("probe-active", () => this.probe({
          root: targetPath,
          pythonExecutable: activePython,
          ffmpegPath: ffmpeg.path,
          accelerator: selectedAccelerator,
          platform: this.platform,
          baseEnv: this.baseEnv,
          signal,
        }));
        const healthy = this._applyBundledFfmpegState(probedHealth, ffmpeg);
        if (healthy?.success !== false) {
          if (previous && !this._isSafePythonPointerPath(previous.pythonExecutableRelative)) {
            await this._writeJsonAtomic(this.activePointerPath, {
              ...previous,
              pythonExecutableRelative: path.relative(targetPath, activePython).replace(/\\/g, "/"),
            }, "migrate-pointer");
            previous = { ...previous, pythonExecutableRelative: path.relative(targetPath, activePython).replace(/\\/g, "/") };
          }
          await this._clearFailureReceipt();
          const status = healthy?.degraded ? BOOTSTRAP_STATUS.DEGRADED : BOOTSTRAP_STATUS.READY;
          this._setStatus(status, { activePath: targetPath, finishedAt: this.now() });
          reportProgress({
            phase: "complete",
            status: "complete",
            percent: 100,
            message: healthy?.degraded ? "现有运行环境可用，但视频组件需要修复。" : "现有运行环境校验通过。",
          });
          return {
            success: true,
            degraded: Boolean(healthy?.degraded),
            created: false,
            reused: true,
            selection,
            spec,
            health: healthy,
            activePath: targetPath,
            state: this.getState(),
          };
        }
        reportProgress({
          phase: "repair-environment",
          percent: 11,
          message: force
            ? "现有运行环境未通过完整性校验，正在按缺失步骤修复。"
            : "现有运行环境未通过完整性校验，正在重建缺失步骤。",
        });
      }

      const selectedSources = await this._step("probe-package-sources", () =>
        this._selectSources(selectedAccelerator, sources, requirements.requirementsLockPath, signal)
      );
      Object.assign(sources, selectedSources.sources);
      this.state.sourceSelection = selectedSources.selection;
      reportProgress({
        phase: "probe-package-sources",
        percent: 14,
        message: `已选择依赖下载源：Python ${selectedSources.selection.python.selected.url}；PyTorch ${selectedSources.selection.torch.selected.url}`,
      });

      stagingPath = path.join(this.stagingRoot, operationId);
      this.state.stagingPath = stagingPath;
      await this.fs.mkdir(stagingPath, { recursive: true });
      let seededFromActive = false;
      if (previous?.specHash === spec.specHash && previous?.absolutePath === targetPath) {
        try {
          await this.fs.cp(targetPath, stagingPath, { recursive: true, force: true });
          seededFromActive = true;
          reportProgress({
            phase: "reuse-environment",
            percent: 12,
            message: "已保留现有运行环境内容，将只修复缺失或损坏的步骤。",
          });
        } catch {
          await this.fs.rm(stagingPath, { recursive: true, force: true });
          await this.fs.mkdir(stagingPath, { recursive: true });
        }
      }
      await this.fs.writeFile(path.join(stagingPath, ".operation.json"), `${JSON.stringify({
        schema: ENVIRONMENT_BOOTSTRAP_SCHEMA,
        operationId,
        pid: process.pid,
        targetPath,
        startedAt: new Date(startedAt).toISOString(),
      }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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
      const venvPython = this.platform === "win32"
        ? path.join(venvPath, "Scripts", "python.exe")
        : path.join(venvPath, "bin", "python");
      const reusableVenv = seededFromActive && await this._isCompatiblePython(venvPython, signal);
      if (reusableVenv) {
        reportProgress({ phase: "create-venv", percent: 45, message: "项目虚拟环境校验通过，跳过创建。" });
      } else {
        await this.fs.rm(venvPath, { recursive: true, force: true });
        reportProgress({ phase: "create-venv", percent: 40, message: "正在创建项目虚拟环境。" });
        await this._step("create-venv", () => this._run(python, ["-m", "venv", venvPath], "create-venv", signal));
      }
      const usablePip = reusableVenv && await this._hasUsablePip(venvPython, signal);
      if (usablePip) {
        reportProgress({ phase: "pip-ready", percent: 55, message: "pip 校验通过，跳过更新。" });
      } else {
        reportProgress({ phase: "upgrade-pip", percent: 50, message: "正在更新 pip。" });
        await this._step("upgrade-pip", () => this._run(venvPython, ["-m", "pip", "install", "--upgrade", "pip", "--index-url", sources.pipIndexUrl], "upgrade-pip", signal));
        reportProgress({ phase: "pip-ready", percent: 55, message: "pip 更新完成。" });
      }
      if (!requirements.requirementsPath) {
        throw new EnvironmentBootstrapError("requirementsPath is required", "ENVIRONMENT_REQUIREMENTS_PATH_REQUIRED");
      }
      const installArgs = ["-m", "pip", "install", "-r", requiredPath(requirements.requirementsPath, "requirementsPath"), "--index-url", sources.pipIndexUrl];
      if (sources.torchIndexUrl) {
        if (sources.torchInstallMode === TORCH_SOURCE_MODES.FIND_LINKS) {
          installArgs.push("--find-links", sources.torchInstallUrl || sources.torchIndexUrl);
        } else if (sources.torchInstallMode !== TORCH_SOURCE_MODES.UNSUPPORTED) {
          installArgs.push("--extra-index-url", sources.torchInstallUrl || sources.torchIndexUrl);
        }
      }
      if (sources.extraIndexUrl) installArgs.push("--extra-index-url", sources.extraIndexUrl);
      const dependenciesReady = reusableVenv && usablePip && await this._lockedRequirementsSatisfied(
        venvPython,
        requirements.requirementsPath,
        signal,
      );
      if (dependenciesReady) {
        reportProgress({ phase: "dependencies-ready", percent: 86, message: "锁定依赖校验通过，跳过安装。" });
      } else {
        reportProgress({
          phase: "install-requirements",
          percent: 60,
          message: "正在安装 Python 与 PyTorch 依赖。此步骤耗时较长，可关闭弹窗继续使用软件；实际功能将在运行环境就绪后生效。",
        });
        const streamOutput = (stream) => (value) => {
          const message = redactSensitiveText(String(value || ""));
          if (!message.trim()) return;
          reportProgress({
            phase: "install-requirements-output",
            status: "running",
            logOnly: true,
            terminalType: stream === "stderr" ? "warning" : "info",
            message,
          });
        };
        await this._step("install-requirements", () => this._run(
          venvPython,
          installArgs,
          "install-requirements",
          signal,
          { onStdout: streamOutput("stdout"), onStderr: streamOutput("stderr") },
        ));
        reportProgress({ phase: "dependencies-ready", percent: 86, message: "Python 与 PyTorch 依赖安装完成。" });
      }
      if (sam3Wheel) {
        reportProgress({ phase: "install-sam3-wheel", percent: 88, message: "正在安装随包的 SAM3 CUDA 组件。" });
        await this._installSam3Wheel(venvPython, sam3Wheel, signal);
      }
      reportProgress({
        phase: "resolve-ffmpeg",
        percent: 88,
        message: ffmpeg.available
          ? "应用内置 FFmpeg 校验通过。"
          : "应用内置 FFmpeg 不可用，将以图片功能模式继续。",
      });
      this._setStatus(BOOTSTRAP_STATUS.PROBING);
      reportProgress({ phase: "health-probe", percent: 94, message: "正在校验 Python、PyTorch、后端模块与 FFmpeg。" });
      const probedHealth = await this._step("probe-environment", () => this.probe({
        root: stagingPath,
        pythonExecutable: venvPython,
        ffmpegPath: ffmpeg.path,
        accelerator: selectedAccelerator,
        platform: this.platform,
        baseEnv: this.baseEnv,
        signal,
      }));
      const health = this._applyBundledFfmpegState(probedHealth, ffmpeg);
      if (health?.success === false) {
        throw new EnvironmentBootstrapError("Environment health probe failed", "ENVIRONMENT_PROBE_FAILED", { health });
      }
      await this.fs.mkdir(stagingPath, { recursive: true });
      await this.fs.writeFile(path.join(stagingPath, "environment-spec.json"), `${JSON.stringify(spec, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await this.fs.writeFile(path.join(stagingPath, ".ready.json"), `${JSON.stringify({
        schema: ENVIRONMENT_BOOTSTRAP_SCHEMA,
        specHash: spec.specHash,
        degraded: Boolean(health?.degraded),
        readyAt: new Date(this.now()).toISOString(),
      }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      const pointer = {
        schema: ENVIRONMENT_BOOTSTRAP_SCHEMA,
        accelerator: selectedAccelerator,
        specHash: spec.specHash,
        path: path.relative(this.rootDir, targetPath).replace(/\\/g, "/"),
        activatedAt: new Date(this.now()).toISOString(),
        pythonExecutableRelative: path.relative(stagingPath, venvPython).replace(/\\/g, "/"),
        ffmpegSource: "bundled",
      };
      await this.fs.rm(path.join(stagingPath, ".operation.json"), { force: true });
      await this._step("activate", () => this._activate(stagingPath, targetPath, pointer, operationId, previous));
      stagingPath = null;
      await this._clearFailureReceipt();
      if (previous && previous.specHash !== pointer.specHash) await this._appendHistory(previous);
      const completedStatus = health?.degraded ? BOOTSTRAP_STATUS.DEGRADED : BOOTSTRAP_STATUS.READY;
      this._setStatus(completedStatus, { stagingPath: null, activePath: targetPath, finishedAt: this.now() });
      reportProgress({
        phase: "complete",
        status: "complete",
        percent: 100,
        message: health?.degraded ? "运行环境创建完成，但视频组件需要修复。" : "运行环境创建并校验完成。",
      });
      return {
        success: true,
        degraded: Boolean(health?.degraded),
        created: true,
        reused: false,
        selection,
        spec,
        health,
        activePath: targetPath,
        state: this.getState(),
      };
    } catch (error) {
      if (stagingPath) await this.fs.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
      const normalized = signal?.aborted
        ? cancellationError(signal)
        : error instanceof EnvironmentBootstrapError
        ? error
        : new EnvironmentBootstrapError(error?.message || String(error), "ENVIRONMENT_BOOTSTRAP_FAILED", { cause: error });
      const cancelled = normalized.code === "ENVIRONMENT_PREPARATION_CANCELLED";
      if (!cancelled) {
        await this._writeFailureReceipt({
          error: normalized,
          progress: lastProgress,
          targetPath: this.state.targetPath,
          operationId,
        }).catch(() => {});
      }
      this._setStatus(cancelled ? BOOTSTRAP_STATUS.CANCELLED : BOOTSTRAP_STATUS.FAILED, {
        stagingPath: null,
        error: cancelled ? null : serializeError(normalized),
        finishedAt: this.now(),
      });
      reportProgress({
        phase: lastProgress.phase || "failed",
        status: cancelled ? "cancelled" : "failed",
        message: normalized.message,
        error: cancelled ? null : serializeError(normalized),
      });
      return {
        success: false,
        cancelled,
        code: normalized.code,
        error: normalized.message,
        details: clone(normalized.details),
        state: this.getState(),
      };
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
        const paths = await this._offlineRuntimePaths(targetPath);
        const probedHealth = await this._step("probe-offline-active", () => this.probe({
          root: targetPath,
          pythonExecutable: paths.pythonExecutable,
          ffmpegPath: paths.ffmpegPath,
          accelerator: verified.selectedAccelerator,
          platform: this.platform,
          baseEnv: this.baseEnv,
          signal,
        }));
        const health = this._applyBundledFfmpegState(probedHealth, paths.ffmpegResource);
        if (health?.success !== false) {
          const status = health?.degraded ? BOOTSTRAP_STATUS.DEGRADED : BOOTSTRAP_STATUS.READY;
          this._setStatus(status, { activePath: targetPath, finishedAt: this.now() });
          return {
            success: true,
            degraded: Boolean(health?.degraded),
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
      const paths = await this._step("locate-offline-runtime", () => this._offlineRuntimePaths(stagingPath));
      if (paths.condaUnpackExecutable) {
        await this._step("relocate-offline-runtime", () => this._run(paths.condaUnpackExecutable, [], "relocate-offline-runtime", signal));
      }
      this._setStatus(BOOTSTRAP_STATUS.PROBING);
      const probedHealth = await this._step("probe-offline-environment", () => this.probe({
        root: stagingPath,
        pythonExecutable: paths.pythonExecutable,
        ffmpegPath: paths.ffmpegPath,
        accelerator: verified.selectedAccelerator,
        platform: this.platform,
        baseEnv: this.baseEnv,
        signal,
      }));
      const health = this._applyBundledFfmpegState(probedHealth, paths.ffmpegResource);
      if (health?.success === false) {
        throw new EnvironmentBootstrapError("Offline environment health probe failed", "ENVIRONMENT_PROBE_FAILED", { health });
      }
      await this.fs.writeFile(path.join(stagingPath, "environment-spec.json"), `${JSON.stringify(spec, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await this.fs.writeFile(path.join(stagingPath, ".ready.json"), `${JSON.stringify({
        schema: ENVIRONMENT_BOOTSTRAP_SCHEMA,
        specHash: spec.specHash,
        source: "offline-payload",
        payloadVariant: verified.variant,
        degraded: Boolean(health?.degraded),
        readyAt: new Date(this.now()).toISOString(),
      }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      const pointer = {
        schema: ENVIRONMENT_BOOTSTRAP_SCHEMA,
        accelerator: verified.selectedAccelerator,
        specHash: spec.specHash,
        path: path.relative(this.rootDir, targetPath).replace(/\\/g, "/"),
        activatedAt: new Date(this.now()).toISOString(),
        pythonExecutableRelative: path.relative(stagingPath, paths.pythonExecutable).replace(/\\/g, "/"),
        ffmpegSource: "bundled",
        source: "offline-payload",
      };
      await this._step("activate-offline-payload", () => this._activate(stagingPath, targetPath, pointer, operationId, previous));
      stagingPath = null;
      if (previous && previous.specHash !== pointer.specHash) await this._appendHistory(previous);
      const completedStatus = health?.degraded ? BOOTSTRAP_STATUS.DEGRADED : BOOTSTRAP_STATUS.READY;
      this._setStatus(completedStatus, { stagingPath: null, activePath: targetPath, finishedAt: this.now() });
      return {
        success: true,
        degraded: Boolean(health?.degraded),
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
