import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  session,
  Menu,
  shell,
  protocol,
  net,
} from "electron";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import crypto from "node:crypto";
import fs from "fs";
import https from "https";
import { spawn, spawnSync, exec } from "child_process";
import { promisify } from "util";
import {
  INTEGRITY_MANIFEST_FILE,
  INTEGRITY_PUBLIC_KEY_PEM,
  INTEGRITY_RESOURCE_DIR,
  INTEGRITY_SIGNATURE_FILE,
  PACKAGED_BACKEND_PROJECT_DIR,
  PACKAGED_BACKEND_RESOURCE_DIR,
  PACKAGED_DEFAULT_MODEL_FILE,
  PACKAGED_MODELS_RESOURCE_DIR,
  PACKAGED_RUNTIME_ENV_DIR,
  PACKAGED_RUNTIME_METADATA_FILE,
  PACKAGED_RUNTIME_RESOURCE_DIR,
  PACKAGED_RUNTIME_TARGET_DIR,
} from "./integrity/public-key.js";
const execAsync = promisify(exec);
// Backend service process
let backendProcess = null;
global.projectPath = "";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "atom",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);
const DEFAULT_BRAND_COLORS = Object.freeze({
  primary: "#7758c4",
  secondary: "#2679a6",
  accent: "#9C27B0",
});
const DEFAULT_IMAGE_BRUSH = Object.freeze({
  size: 20,
  color: "#1976D2",
  alpha: 0.75,
});
const DEFAULT_VIDEO_BRUSH = Object.freeze({
  size: 24,
  color: DEFAULT_IMAGE_BRUSH.color,
  alpha: 0.75,
});
const SHORTCUT_DEFAULTS = Object.freeze({
  drawingUndo: ["Ctrl", "Z"],
  drawingResetView: ["Ctrl", "X"],
  drawingToggle: ["Ctrl", "Space"],
  drawingBrush: ["1"],
  drawingRect: ["2"],
  drawingErase: ["3"],
  drawingHoldBrush: ["1", "Q"],
  drawingHoldRect: ["2", "Q"],
  drawingHoldErase: ["3", "E"],
  imageUndoProcessing: ["Ctrl", "Alt", "Z"],
  imageCompareOriginal: ["Ctrl", "Alt", "X"],
  imageSelectAll: ["Ctrl", "A"],
});
const SHORTCUT_KEY_COUNTS = Object.freeze({
  drawingUndo: 2,
  drawingResetView: 2,
  drawingToggle: 2,
  drawingBrush: 1,
  drawingRect: 1,
  drawingErase: 1,
  drawingHoldBrush: 2,
  drawingHoldRect: 2,
  drawingHoldErase: 2,
  imageUndoProcessing: 3,
  imageCompareOriginal: 3,
  imageSelectAll: 2,
});
const IMAGE_OUTPUT_NAMING_MODES = Object.freeze(["original", "prefixUuid"]);
// Default configuration
const DEFAULT_CONFIG = {
  general: {
    backendPort: 8080,
    launchMode: "cuda", // 'cuda' | 'cpu'
    modelPath: "",
    modelDir: "",
    backendProjectPath: "",
    defaultModel: "lama",
  },
  fileManagement: {
    downloadPath: "",
    tempPath: "",
    imageFolderName: "images",
    videoFolderName: "videos",
  },
  advanced: {
    imageHistoryLimit: 10,
    imageWarningSize: 50, // MB
    stateSaveLimit: 100, // MB
    imageProcessingMethod: "path",
    imageOutputNamingMode: "original",
    imageOutputFixedPrefix: "moonshine",
    imageBrushDefault: { ...DEFAULT_IMAGE_BRUSH },
    videoBrushDefault: { ...DEFAULT_VIDEO_BRUSH },
  },
  ui: {
    theme: "light",
    buttonSize: "sm",
    brandColors: { ...DEFAULT_BRAND_COLORS },
    showWelcomeDialog: true,
    confirmBeforeExit: true,
    autoSaveInterval: 30000,
  },
  shortcuts: JSON.parse(JSON.stringify(SHORTCUT_DEFAULTS)),
  video: {
    frameExtractionFormat: "jpg",
    batchFrameCount: 120,
    historyLimit: 5,
    defaultFrameRate: 30,
    maxKeyframes: 100,
    autoNextFrameInterval: 0.1,
    tempFramesPath: "",
    supportedFormats: ["mp4", "mov", "avi", "mkv", "wmv"],
    maxConcurrentFrameProcessing: 4,
    enableFrameSkipping: true,
    memoryOptimization: true,
    autoSaveInterval: 30,
    maxDraftRetention: 7,
    batchRetryCount: 3,
    failureRetentionCount: 3,
    proxyMaxSide: 1280,
  },
};
// Global configuration object
let globalConfig = { ...DEFAULT_CONFIG };

const TARGET_PYTHON_VERSION = "3.11.5";
const MIN_SYSTEM_PYTHON_MINOR = 10;
const MAX_SYSTEM_PYTHON_MINOR = 12;
const BUNDLED_RUNTIME_STATE_FILE = "runtime-state.json";
const BUNDLED_RUNTIME_LOCK_FILE = ".prepare.lock";
const BUNDLED_RUNTIME_LOCK_WAIT_MS = 300000;
const BUNDLED_RUNTIME_LOCK_STALE_MS = 120000;
const VIDEO_PROCESSING_REGISTRY_FILE = "moonshine_video_resume_index.json";
const QUICK_FINGERPRINT_SAMPLE_SIZE = 64 * 1024;
let packagedIntegrityStatus = null;

function normalizeShortcutKeys(keys = []) {
  const normalized = Array.from(
    new Set(
      (Array.isArray(keys) ? keys : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .map((item) => {
          if (item === " " || item === "Space") return "Space";
          if (item === "Control") return "Ctrl";
          return item.length === 1 ? item.toUpperCase() : item;
        })
    )
  );

  return normalized.sort((left, right) => {
    const order = ["Ctrl", "Alt", "Shift", "Meta"];
    const leftIndex = order.indexOf(left);
    const rightIndex = order.indexOf(right);
    if (leftIndex !== -1 || rightIndex !== -1) {
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    }
    return left.localeCompare(right);
  });
}

function normalizeShortcutConfig(shortcuts = {}) {
  const nextConfig = {};

  Object.entries(SHORTCUT_DEFAULTS).forEach(([actionId, defaultKeys]) => {
    const normalizedKeys = normalizeShortcutKeys(shortcuts?.[actionId] || defaultKeys);
    nextConfig[actionId] =
      normalizedKeys.length === SHORTCUT_KEY_COUNTS[actionId]
        ? normalizedKeys
        : [...defaultKeys];
  });

  return nextConfig;
}

function validateShortcutConfig(shortcuts = {}) {
  const normalized = normalizeShortcutConfig(shortcuts);
  const seen = new Set();

  return Object.entries(normalized).every(([actionId, keys]) => {
    if (keys.length !== SHORTCUT_KEY_COUNTS[actionId]) {
      return false;
    }

    const signature = keys.join("+");
    if (seen.has(signature)) {
      return false;
    }
    seen.add(signature);
    return true;
  });
}

function getResourcesRootPath() {
  return process.resourcesPath || path.dirname(app.getAppPath());
}

function getLegacyPackagedBackendProjectPath() {
  return path.join(getResourcesRootPath(), PACKAGED_BACKEND_PROJECT_DIR);
}

function getPackagedBackendProjectPath() {
  return path.join(
    getResourcesRootPath(),
    PACKAGED_BACKEND_RESOURCE_DIR,
    PACKAGED_BACKEND_PROJECT_DIR
  );
}

function getPackagedRuntimeResourceRootPath() {
  return path.join(
    getResourcesRootPath(),
    PACKAGED_RUNTIME_RESOURCE_DIR,
    PACKAGED_RUNTIME_TARGET_DIR
  );
}

function getPackagedRuntimeEnvPath() {
  return path.join(getPackagedRuntimeResourceRootPath(), PACKAGED_RUNTIME_ENV_DIR);
}

function getPackagedRuntimeMetadataPath() {
  return path.join(getPackagedRuntimeResourceRootPath(), PACKAGED_RUNTIME_METADATA_FILE);
}

function getPackagedModelsPath() {
  return path.join(getResourcesRootPath(), PACKAGED_MODELS_RESOURCE_DIR);
}

function getBundledDefaultModelPath() {
  return path.join(getPackagedModelsPath(), PACKAGED_DEFAULT_MODEL_FILE);
}

function getBundledRuntimeRootPath() {
  return path.join(app.getPath("userData"), "runtime");
}

function getBundledRuntimeEnvPath() {
  return getPackagedRuntimeEnvPath();
}

function getBundledRuntimeStatePath() {
  return path.join(getBundledRuntimeRootPath(), BUNDLED_RUNTIME_STATE_FILE);
}

function getBundledRuntimeLockPath() {
  return path.join(getBundledRuntimeRootPath(), BUNDLED_RUNTIME_LOCK_FILE);
}

function getVideoProcessingStateDirectory() {
  return path.join(app.getPath("userData"), "video-processing");
}

function getVideoProcessingRegistryPath() {
  return path.join(getVideoProcessingStateDirectory(), VIDEO_PROCESSING_REGISTRY_FILE);
}

function ensureParentDirectory(filePath) {
  const parentDirectory = path.dirname(filePath);
  if (!fs.existsSync(parentDirectory)) {
    fs.mkdirSync(parentDirectory, { recursive: true });
  }
}

function readJsonFileSafe(filePath, fallbackValue = null) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallbackValue;
    }

    const rawText = fs.readFileSync(filePath, "utf8");
    if (!rawText.trim()) {
      return fallbackValue;
    }

    return JSON.parse(rawText);
  } catch (error) {
    console.error(`Failed to read JSON file: ${filePath}`, error);
    return fallbackValue;
  }
}

function writeJsonFileSafe(filePath, data) {
  ensureParentDirectory(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function readVideoProcessingRegistry() {
  const registry =
    readJsonFileSafe(getVideoProcessingRegistryPath(), {
      version: 1,
      updatedAt: new Date().toISOString(),
      tasks: {},
    }) || {};

  return {
    version: 1,
    updatedAt: registry.updatedAt || new Date().toISOString(),
    tasks:
      registry.tasks && typeof registry.tasks === "object" && !Array.isArray(registry.tasks)
        ? registry.tasks
        : {},
  };
}

function writeVideoProcessingRegistry(registry) {
  writeJsonFileSafe(getVideoProcessingRegistryPath(), {
    version: 1,
    updatedAt: new Date().toISOString(),
    tasks:
      registry?.tasks && typeof registry.tasks === "object" && !Array.isArray(registry.tasks)
        ? registry.tasks
        : {},
  });
}

function buildQuickFingerprintSpans(fileSize, sampleSize = QUICK_FINGERPRINT_SAMPLE_SIZE) {
  const normalizedSize = Math.max(0, Number(fileSize || 0));
  const normalizedSampleSize = Math.max(1, Number(sampleSize || QUICK_FINGERPRINT_SAMPLE_SIZE));
  const spans = [];

  const pushSpan = (start, length) => {
    const normalizedStart = Math.max(0, Math.min(normalizedSize, Math.floor(start)));
    const normalizedLength = Math.max(
      0,
      Math.min(normalizedSize - normalizedStart, Math.floor(length))
    );

    if (!(normalizedLength > 0)) {
      return;
    }

    spans.push({
      start: normalizedStart,
      end: normalizedStart + normalizedLength,
    });
  };

  pushSpan(0, Math.min(normalizedSampleSize, normalizedSize));
  pushSpan(
    Math.max(0, Math.floor(normalizedSize / 2) - Math.floor(normalizedSampleSize / 2)),
    Math.min(normalizedSampleSize, normalizedSize)
  );
  pushSpan(
    Math.max(0, normalizedSize - normalizedSampleSize),
    Math.min(normalizedSampleSize, normalizedSize)
  );

  spans.sort((left, right) => left.start - right.start);

  const mergedSpans = [];
  spans.forEach((span) => {
    const previousSpan = mergedSpans.at(-1);
    if (!previousSpan || span.start > previousSpan.end) {
      mergedSpans.push({ ...span });
      return;
    }

    previousSpan.end = Math.max(previousSpan.end, span.end);
  });

  return mergedSpans.map((span) => ({
    start: span.start,
    length: Math.max(0, span.end - span.start),
  }));
}

function createQuickFileFingerprint(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`File does not exist: ${filePath}`);
  }

  const stats = fs.statSync(filePath);
  if (!stats.isFile()) {
    throw new Error(`Unsupported file path: ${filePath}`);
  }

  const sampleSpans = buildQuickFingerprintSpans(stats.size);
  const hash = crypto.createHash("sha256");
  hash.update(`size:${stats.size};`);

  const fd = fs.openSync(filePath, "r");
  try {
    sampleSpans.forEach((span) => {
      const chunk = Buffer.alloc(span.length);
      const bytesRead = fs.readSync(fd, chunk, 0, span.length, span.start);
      hash.update(`offset:${span.start};length:${bytesRead};`);
      hash.update(chunk.subarray(0, bytesRead));
    });
  } finally {
    fs.closeSync(fd);
  }

  return {
    fingerprint: `quicksha256:${hash.digest("hex")}`,
    size: stats.size,
    sampleSize: QUICK_FINGERPRINT_SAMPLE_SIZE,
    lastModified: stats.mtime.getTime(),
  };
}

function getVideoTaskTimestamp(task = {}) {
  return Math.max(0, Number(task.updatedAt || task.createdAt || 0));
}

function getPackagedBackendRuntimeProjectPath() {
  return path.join(getBundledRuntimeRootPath(), "backend", PACKAGED_BACKEND_PROJECT_DIR);
}

function getBundledPythonPath() {
  return os.platform() === "win32"
    ? path.join(getBundledRuntimeEnvPath(), "python.exe")
    : path.join(getBundledRuntimeEnvPath(), "bin", "python");
}

function quoteArg(arg) {
  return `"${String(arg).replace(/"/g, '\\"')}"`;
}

async function execCommand(command, options = {}) {
  return execAsync(command, {
    env: { ...process.env },
    shell: true,
    ...options,
  });
}

function parsePythonVersion(text) {
  const match = String(text || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    text: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

function isSystemPythonVersionSupported(versionInfo) {
  return (
    versionInfo &&
    versionInfo.major === 3 &&
    versionInfo.minor >= MIN_SYSTEM_PYTHON_MINOR &&
    versionInfo.minor <= MAX_SYSTEM_PYTHON_MINOR
  );
}

function getDefaultBackendProjectPath() {
  if (app.isPackaged) {
    return getPackagedBackendRuntimeProjectPath();
  }

  const workingTreeProjectPath = path.join(process.cwd(), PACKAGED_BACKEND_PROJECT_DIR);
  if (fs.existsSync(workingTreeProjectPath)) {
    return workingTreeProjectPath;
  }

  return path.join(path.dirname(app.getAppPath()), PACKAGED_BACKEND_PROJECT_DIR);
}

function normalizeStoredBackendProjectPath(projectPath) {
  const normalizedInput = String(projectPath || "").trim();
  if (!app.isPackaged) {
    return normalizedInput || getDefaultBackendProjectPath();
  }

  const packagedPath = path.normalize(getPackagedBackendProjectPath());
  const legacyPath = path.normalize(getLegacyPackagedBackendProjectPath());
  const runtimePath = path.normalize(getPackagedBackendRuntimeProjectPath());
  if (!normalizedInput) {
    return runtimePath;
  }

  const normalizedPath = path.normalize(normalizedInput);
  if (normalizedPath === legacyPath || normalizedPath === packagedPath) {
    return runtimePath;
  }

  return normalizedInput;
}

function usesPackagedBackendProject(projectPath) {
  if (!app.isPackaged) {
    return false;
  }

  const normalizedPath = path.normalize(String(projectPath || ""));
  return (
    normalizedPath === path.normalize(getPackagedBackendProjectPath()) ||
    normalizedPath === path.normalize(getLegacyPackagedBackendProjectPath()) ||
    normalizedPath === path.normalize(getPackagedBackendRuntimeProjectPath())
  );
}

function isBundledBackendMode(projectPath) {
  if (!app.isPackaged) {
    return false;
  }

  const normalizedPath = path.normalize(
    normalizeStoredBackendProjectPath(projectPath || getDefaultBackendProjectPath())
  );
  return normalizedPath === path.normalize(getPackagedBackendRuntimeProjectPath());
}

function getIntegrityArtifactPaths() {
  const integrityRoot = path.join(getResourcesRootPath(), INTEGRITY_RESOURCE_DIR);
  return {
    integrityRoot,
    manifestPath: path.join(integrityRoot, INTEGRITY_MANIFEST_FILE),
    signaturePath: path.join(integrityRoot, INTEGRITY_SIGNATURE_FILE),
  };
}

function isPathInsideDirectory(candidatePath, rootDir) {
  const relativePath = path.relative(rootDir, candidatePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function verifyPackagedManifestEntry(entry, resourcesRoot) {
  if (!entry || typeof entry !== "object") {
    return "Manifest entry must be an object.";
  }

  if (!entry.path || typeof entry.path !== "string") {
    return "Manifest entry path is missing.";
  }

  if (typeof entry.size !== "number" || entry.size < 0) {
    return `Manifest entry has an invalid size: ${entry.path}`;
  }

  if (!entry.sha256 || typeof entry.sha256 !== "string") {
    return `Manifest entry has an invalid sha256 value: ${entry.path}`;
  }

  const absolutePath = path.resolve(resourcesRoot, entry.path);
  if (!isPathInsideDirectory(absolutePath, resourcesRoot)) {
    return `Manifest entry points outside the resources directory: ${entry.path}`;
  }

  if (!fs.existsSync(absolutePath)) {
    return `Protected resource is missing: ${entry.path}`;
  }

  const stats = fs.statSync(absolutePath);
  if (!stats.isFile()) {
    return `Protected resource is not a file: ${entry.path}`;
  }

  if (stats.size !== entry.size) {
    return `Protected resource size mismatch: ${entry.path}`;
  }

  const actualHash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(absolutePath))
    .digest("hex");
  if (actualHash !== entry.sha256) {
    return `Protected resource hash mismatch: ${entry.path}`;
  }

  return null;
}

async function verifyPackagedResourcesIntegrity() {
  if (!app.isPackaged) {
    return { success: true, skipped: true };
  }

  if (packagedIntegrityStatus) {
    return packagedIntegrityStatus;
  }

  try {
    const resourcesRoot = getResourcesRootPath();
    const { manifestPath, signaturePath } = getIntegrityArtifactPaths();

    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Missing integrity manifest: ${manifestPath}`);
    }

    if (!fs.existsSync(signaturePath)) {
      throw new Error(`Missing integrity signature: ${signaturePath}`);
    }

    const manifestBuffer = fs.readFileSync(manifestPath);
    const signature = fs.readFileSync(signaturePath, "utf8").trim();
    if (!signature) {
      throw new Error("Integrity signature file is empty.");
    }

    const signatureValid = crypto.verify(
      null,
      manifestBuffer,
      INTEGRITY_PUBLIC_KEY_PEM,
      Buffer.from(signature, "base64")
    );
    if (!signatureValid) {
      throw new Error("Integrity manifest signature verification failed.");
    }

    const manifest = JSON.parse(manifestBuffer.toString("utf8"));
    if (manifest.schemaVersion !== 1) {
      throw new Error(`Unsupported integrity manifest schema: ${manifest.schemaVersion}`);
    }

    if (manifest.hashAlgorithm !== "sha256") {
      throw new Error(`Unsupported integrity hash algorithm: ${manifest.hashAlgorithm}`);
    }

    if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
      throw new Error("Integrity manifest does not contain any protected entries.");
    }

    for (const entry of manifest.entries) {
      const entryError = verifyPackagedManifestEntry(entry, resourcesRoot);
      if (entryError) {
        throw new Error(entryError);
      }
    }

    packagedIntegrityStatus = {
      success: true,
      checkedAt: new Date().toISOString(),
      entryCount: manifest.entries.length,
    };
    return packagedIntegrityStatus;
  } catch (error) {
    packagedIntegrityStatus = {
      success: false,
      error: error.message || "Integrity verification failed.",
    };
    return packagedIntegrityStatus;
  }
}

async function ensurePackagedBackendIntegrity(projectPath) {
  if (!usesPackagedBackendProject(projectPath)) {
    return { success: true, skipped: true };
  }

  const integrityResult = await verifyPackagedResourcesIntegrity();
  if (!integrityResult.success) {
    return integrityResult;
  }

  const { manifestPath } = getIntegrityArtifactPaths();
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const runtimeProjectPath = getPackagedBackendRuntimeProjectPath();
  const backendPrefix = `${PACKAGED_BACKEND_RESOURCE_DIR}/${PACKAGED_BACKEND_PROJECT_DIR}/`;

  for (const entry of manifest.entries) {
    if (!entry?.path?.startsWith(backendPrefix)) {
      continue;
    }

    const relativePath = entry.path.slice(backendPrefix.length).replace(/\//g, path.sep);
    const sourcePath = path.join(getResourcesRootPath(), entry.path);
    const targetPath = path.join(runtimeProjectPath, relativePath);
    const targetDir = path.dirname(targetPath);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    let shouldCopy = true;
    if (fs.existsSync(targetPath)) {
      const stats = fs.statSync(targetPath);
      shouldCopy =
        !stats.isFile() ||
        stats.size !== entry.size ||
        crypto.createHash("sha256").update(fs.readFileSync(targetPath)).digest("hex") !==
          entry.sha256;
    }

    if (shouldCopy) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }

  return {
    ...integrityResult,
    runtimeProjectPath,
  };
}

function getBundledRuntimeCommandEnv(overrides = {}) {
  const modelDir = getPackagedModelsPath();
  return {
    ...process.env,
    ...overrides,
    TORCH_HOME: modelDir,
    XDG_CACHE_HOME: modelDir,
    U2NET_HOME: modelDir,
    HF_HOME: path.join(modelDir, "huggingface"),
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    LAMA_MODEL_URL: getBundledDefaultModelPath(),
  };
}

function getEffectiveBundledModelDir() {
  return getPackagedModelsPath();
}

async function runProcess(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      stdio: options.stdio || "pipe",
      shell: options.shell || false,
    });

    let stdout = "";
    let stderr = "";

    if (child.stdout) {
      child.stdout.on("data", (data) => {
        const text = data.toString();
        stdout += text;
        options.onStdout?.(text);
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (data) => {
        const text = data.toString();
        stderr += text;
        options.onStderr?.(text);
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(
          options.errorMessage ||
            `${command} ${args.join(" ")} failed with exit code ${code}`
        );
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

async function runBundledCondaUnpack(sendLog) {
  const envPath = getBundledRuntimeEnvPath();
  const pythonPath = getBundledPythonPath();
  const exeCandidate = path.join(envPath, "Scripts", "conda-unpack.exe");
  const scriptCandidate = path.join(envPath, "Scripts", "conda-unpack-script.py");

  sendLog?.("Relocating bundled Python runtime...", "info");
  sendLog?.("请耐心等待直到本页面出现以下内容：Bundled backend dependencies are ready.", "info");
  if (fs.existsSync(exeCandidate)) {
    await runProcess(exeCandidate, [], {
      cwd: envPath,
      errorMessage: "Failed to relocate the bundled Python runtime.",
    });
    return;
  }

  if (fs.existsSync(scriptCandidate) && fs.existsSync(pythonPath)) {
    await runProcess(
      pythonPath,
      [scriptCandidate],
      {
        cwd: envPath,
        errorMessage: "Failed to relocate the bundled Python runtime.",
      }
    );
    return;
  }

  throw new Error("Bundled runtime does not contain conda-unpack.");
}

function getBundledRuntimeState() {
  const statePath = getBundledRuntimeStatePath();
  if (!fs.existsSync(statePath)) {
    return null;
  }

  try {
    return readJsonFile(statePath);
  } catch (error) {
    console.warn("Failed to parse bundled runtime state:", error);
    return null;
  }
}

function clearBundledRuntimeState() {
  fs.rmSync(getBundledRuntimeStatePath(), { force: true });
}

function isBundledRuntimeLockStale(lockPath) {
  if (!fs.existsSync(lockPath)) {
    return false;
  }

  try {
    const stats = fs.statSync(lockPath);
    return Date.now() - stats.mtimeMs >= BUNDLED_RUNTIME_LOCK_STALE_MS;
  } catch (error) {
    console.warn("Failed to inspect bundled runtime lock:", error);
    return false;
  }
}

async function withBundledRuntimeLock(task) {
  const runtimeRoot = getBundledRuntimeRootPath();
  const lockPath = getBundledRuntimeLockPath();
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const deadline = Date.now() + BUNDLED_RUNTIME_LOCK_WAIT_MS;

  while (true) {
    try {
      const handle = fs.openSync(lockPath, "wx");
      try {
        return await task();
      } finally {
        fs.closeSync(handle);
        fs.rmSync(lockPath, { force: true });
      }
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      if (isBundledRuntimeLockStale(lockPath)) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error("Timed out while waiting for the bundled runtime lock.");
      }

      await sleep(500);
    }
  }
}

function hasBundledRuntimeStateChanged(runtimeMetadata) {
  const state = getBundledRuntimeState();
  return !(
    state &&
    state.schemaVersion === 2 &&
    state.runtimeBuiltAt === runtimeMetadata.builtAt &&
    state.runtimeEnvPath === getBundledRuntimeEnvPath() &&
    state.resourcesRootPath === getResourcesRootPath() &&
    fs.existsSync(getBundledPythonPath())
  );
}

async function ensureBundledRuntimeReady(sendLog) {
  const integrityResult = await ensurePackagedBackendIntegrity(
    getPackagedBackendRuntimeProjectPath()
  );
  if (!integrityResult.success) {
    return integrityResult;
  }

  if (!fs.existsSync(getPackagedRuntimeEnvPath())) {
    return {
      success: false,
      error: `Bundled runtime directory is missing: ${getPackagedRuntimeEnvPath()}`,
    };
  }

  if (!fs.existsSync(getPackagedRuntimeMetadataPath())) {
    return {
      success: false,
      error: `Bundled runtime metadata is missing: ${getPackagedRuntimeMetadataPath()}`,
    };
  }

  if (!fs.existsSync(getBundledDefaultModelPath())) {
    return {
      success: false,
      error: `Bundled default model is missing: ${getBundledDefaultModelPath()}`,
    };
  }

  const runtimeMetadata = readJsonFile(getPackagedRuntimeMetadataPath());

  await withBundledRuntimeLock(async () => {
    const state = getBundledRuntimeState();
    if (!hasBundledRuntimeStateChanged(runtimeMetadata)) {
      return;
    }

    const appMoved =
      !!state?.runtimeEnvPath && state.runtimeEnvPath !== getBundledRuntimeEnvPath();
    if (appMoved) {
      sendLog?.(
        "Detected that the packaged app path changed. Re-running bundled runtime relocation...",
        "warning"
      );
    }

    try {
      await runBundledCondaUnpack(sendLog);
    } catch (error) {
      if (appMoved) {
        clearBundledRuntimeState();
        error.message = `${error.message} The app appears to have been moved after the bundled runtime was prepared. Please re-extract the packaged app to a fresh directory and try again.`;
      }
      throw error;
    }

    const bundledPython = getBundledPythonPath();
    if (!fs.existsSync(bundledPython)) {
      throw new Error(`Bundled Python executable is missing: ${bundledPython}`);
    }

    writeJsonFile(getBundledRuntimeStatePath(), {
      schemaVersion: 2,
      preparedAt: new Date().toISOString(),
      runtimeBuiltAt: runtimeMetadata.builtAt,
      resourcesRootPath: getResourcesRootPath(),
      runtimeEnvPath: getBundledRuntimeEnvPath(),
      backendPath: getPackagedBackendRuntimeProjectPath(),
      pythonPath: bundledPython,
      modelPath: getBundledDefaultModelPath(),
    });
  });

  const bundledPython = getBundledPythonPath();
  const versionResult = await getPythonVersionFromCommand(quoteArg(bundledPython), {
    cwd: getPackagedBackendRuntimeProjectPath(),
    env: getBundledRuntimeCommandEnv(),
  });

  return {
    success: true,
    path: getPackagedBackendRuntimeProjectPath(),
    pythonPath: bundledPython,
    pythonVersion: versionResult.success ? versionResult.version.text : "",
    pythonSource: "bundled offline runtime",
    venvName: "bundled-runtime",
    venvPath: getBundledRuntimeEnvPath(),
    modelDir: getPackagedModelsPath(),
    backendMode: "bundled",
  };
}

function getVenvPythonPathByVenvPath(venvPath) {
  return os.platform() === "win32"
    ? path.join(venvPath, "Scripts", "python.exe")
    : path.join(venvPath, "bin", "python");
}

function getProjectVenvInfo(projectPath) {
  const candidates = [".venv", "venv"];
  for (const candidateName of candidates) {
    const candidatePath = path.join(projectPath, candidateName);
    if (!fs.existsSync(candidatePath)) {
      continue;
    }

    if (!fs.statSync(candidatePath).isDirectory()) {
      return {
        exists: true,
        valid: false,
        venvName: candidateName,
        venvPath: candidatePath,
        error: `${candidateName} exists, but it is not a directory.`,
      };
    }

    const pythonPath = getVenvPythonPathByVenvPath(candidatePath);
    const pyvenvCfgPath = path.join(candidatePath, "pyvenv.cfg");
    const isValid = fs.existsSync(pythonPath) && fs.existsSync(pyvenvCfgPath);
    if (!isValid) {
      return {
        exists: true,
        valid: false,
        venvName: candidateName,
        venvPath: candidatePath,
        pythonPath,
        error: `${candidateName} exists, but it is not a valid Python virtual environment.`,
      };
    }

    return {
      exists: true,
      valid: true,
      venvName: candidateName,
      venvPath: candidatePath,
      pythonPath,
    };
  }

  return {
    exists: false,
    valid: false,
  };
}

async function getPythonVersionFromCommand(pythonCommand, options = {}) {
  try {
    const { stdout, stderr } = await execCommand(`${pythonCommand} --version`, {
      timeout: 15000,
      ...options,
    });
    const combined = `${stdout || ""}\n${stderr || ""}`.trim();
    const version = parsePythonVersion(combined);
    if (!version) {
      return {
        success: false,
        error: `Unable to parse Python version from output: ${combined}`,
      };
    }
    return { success: true, version };
  } catch (error) {
    return {
      success: false,
      error: error.message || "Python version check command failed.",
    };
  }
}

async function detectSystemPython() {
  const commandCandidates =
    os.platform() === "win32"
      ? ["python", "py -3", "py", "python3"]
      : ["python3", "python"];

  for (const cmd of commandCandidates) {
    const versionResult = await getPythonVersionFromCommand(cmd);
    if (versionResult.success) {
      return {
        success: true,
        command: cmd,
        version: versionResult.version,
      };
    }
  }

  if (os.platform() === "win32") {
    const userName = os.userInfo().username;
    const pathCandidates = [
      "C:\\Python311\\python.exe",
      "C:\\Python310\\python.exe",
      `C:\\Users\\${userName}\\AppData\\Local\\Programs\\Python\\Python311\\python.exe`,
      `C:\\Users\\${userName}\\AppData\\Local\\Programs\\Python\\Python310\\python.exe`,
    ];

    for (const pythonPath of pathCandidates) {
      if (!fs.existsSync(pythonPath)) {
        continue;
      }
      const versionResult = await getPythonVersionFromCommand(
        quoteArg(pythonPath)
      );
      if (versionResult.success) {
        return {
          success: true,
          command: quoteArg(pythonPath),
          version: versionResult.version,
          path: pythonPath,
        };
      }
    }
  }

  return {
    success: false,
    error: "No system Python executable was detected.",
  };
}

async function detectConda() {
  try {
    const { stdout, stderr } = await execCommand("conda --version", {
      timeout: 15000,
    });
    const message = `${stdout || ""}\n${stderr || ""}`.trim();
    if (!message) {
      return { success: false, error: "Conda command returned empty output." };
    }
    return { success: true, version: message };
  } catch (error) {
    return { success: false, error: error.message || "Conda was not detected." };
  }
}

async function createProjectVenvWithPython(projectPath, pythonCommand, sendLog) {
  sendLog?.(`Creating project virtual environment with ${pythonCommand}...`, "info");
  await execCommand(`${pythonCommand} -m venv .venv`, {
    cwd: projectPath,
    timeout: 180000,
  });

  const venvInfo = getProjectVenvInfo(projectPath);
  if (!venvInfo.exists || !venvInfo.valid) {
    throw new Error("Virtual environment creation finished, but .venv is invalid.");
  }
  return venvInfo;
}

async function bootstrapProjectVenvWithConda(projectPath, sendLog) {
  const tempEnvName = `moonshine-image-bootstrap-${Date.now()}`;
  let createdTempEnv = false;
  try {
    sendLog?.(
      `Creating temporary conda environment (${tempEnvName}) with Python ${TARGET_PYTHON_VERSION}...`,
      "info"
    );
    await execCommand(
      `conda create -n ${tempEnvName} python=${TARGET_PYTHON_VERSION} -y`,
      { timeout: 600000 }
    );
    createdTempEnv = true;

    sendLog?.("Creating .venv inside the backend project via conda Python...", "info");
    await execCommand(`conda run -n ${tempEnvName} python -m venv .venv`, {
      cwd: projectPath,
      timeout: 600000,
    });

    const venvInfo = getProjectVenvInfo(projectPath);
    if (!venvInfo.exists || !venvInfo.valid) {
      throw new Error("Conda bootstrap completed, but .venv is invalid.");
    }
    return venvInfo;
  } finally {
    if (createdTempEnv) {
      try {
        sendLog?.(`Removing temporary conda environment (${tempEnvName})...`, "info");
        await execCommand(`conda env remove -n ${tempEnvName} -y`, {
          timeout: 180000,
        });
      } catch (cleanupError) {
        sendLog?.(
          `Failed to remove temporary conda environment: ${cleanupError.message}`,
          "warning"
        );
      }
    }
  }
}

function buildManualVenvGuide(projectPath) {
  const safeProjectPath = projectPath || "<backend project path>";
  return {
    downloadUrl:
      "https://www.python.org/ftp/python/3.11.5/python-3.11.5-amd64.exe",
    commands: [
      `cd /d "${safeProjectPath}"`,
      "py -3.11 -m venv .venv",
      ".\\.venv\\Scripts\\python.exe -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple",
    ],
  };
}

function validateProjectPath(inputPath) {
  const defaultProjectPath = getDefaultBackendProjectPath();
  const defaultProjectParentPath = path.dirname(defaultProjectPath);
  let checkPath = normalizeStoredBackendProjectPath(inputPath);
  if (!checkPath) {
    const defaultPath = defaultProjectPath;
    if (fs.existsSync(defaultPath)) {
      checkPath = defaultPath;
    } else {
      return {
        success: false,
        code: "PROJECT_NOT_SELECTED",
        error: "No backend project path was detected.",
        defaultProjectPath,
        defaultProjectParentPath,
      };
    }
  }

  if (!fs.existsSync(checkPath)) {
    return {
      success: false,
      code: "PROJECT_PATH_NOT_FOUND",
      error: `Backend project path does not exist: ${checkPath}`,
      currentCheckPath: checkPath,
      defaultProjectPath,
      defaultProjectParentPath,
    };
  }

  const requiredFiles = ["requirements.txt", "main.py"];
  const requiredDirs = ["iopaint"];
  const missingFiles = requiredFiles.filter(
    (fileName) => !fs.existsSync(path.join(checkPath, fileName))
  );
  const missingDirs = requiredDirs.filter((dirName) => {
    const dirPath = path.join(checkPath, dirName);
    return !fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory();
  });

  if (missingFiles.length > 0 || missingDirs.length > 0) {
    return {
      success: false,
      code: "PROJECT_STRUCTURE_INVALID",
      error: "Backend project structure is incomplete.",
      missingFiles,
      missingDirs,
      defaultProjectPath,
      defaultProjectParentPath,
    };
  }

  return { success: true, path: checkPath };
}

// Get configuration file path
function getConfigPath() {
  const userDataPath = app.getPath("userData");
  const configDir = path.join(userDataPath, "config");

  // Ensure the configuration directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  return path.join(configDir, "config.json");
}

function mergeConfigWithDefaults(config = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    general: {
      ...DEFAULT_CONFIG.general,
      ...(config.general || {}),
    },
    fileManagement: {
      ...DEFAULT_CONFIG.fileManagement,
      ...(config.fileManagement || {}),
    },
    advanced: {
      ...DEFAULT_CONFIG.advanced,
      ...(config.advanced || {}),
    },
    ui: {
      ...DEFAULT_CONFIG.ui,
      ...(config.ui || {}),
      brandColors: {
        ...DEFAULT_CONFIG.ui.brandColors,
        ...(config.ui?.brandColors || {}),
      },
    },
    shortcuts: {
      ...SHORTCUT_DEFAULTS,
      ...(config.shortcuts || {}),
    },
    video: {
      ...DEFAULT_CONFIG.video,
      ...(config.video || {}),
    },
  };
}

async function getUsableProjectVenvInfo(projectPath) {
  const venvInfo = getProjectVenvInfo(projectPath);
  if (!venvInfo.exists || !venvInfo.valid) {
    return venvInfo;
  }

  const versionResult = await getPythonVersionFromCommand(quoteArg(venvInfo.pythonPath), {
    cwd: projectPath,
  });
  if (!versionResult.success) {
    return {
      ...venvInfo,
      valid: false,
      error: `${venvInfo.venvName} exists, but its Python executable is unusable. ${versionResult.error}`,
    };
  }

  return {
    ...venvInfo,
    pythonVersion: versionResult.version.text,
  };
}

function canAutoRepairProjectVenv(projectPath, venvInfo) {
  return (
    app.isPackaged &&
    usesPackagedBackendProject(projectPath) &&
    !!venvInfo?.venvPath &&
    isPathInsideDirectory(venvInfo.venvPath, projectPath)
  );
}

function removeProjectVenv(venvInfo) {
  if (!venvInfo?.venvPath) {
    return;
  }

  fs.rmSync(venvInfo.venvPath, { recursive: true, force: true });
}

async function resolveValidatedProjectPath(inputPath) {
  const normalizedPath = normalizeStoredBackendProjectPath(inputPath);
  const effectivePath = normalizedPath || getDefaultBackendProjectPath();
  const integrityResult = await ensurePackagedBackendIntegrity(effectivePath);
  if (!integrityResult.success) {
    return {
      success: false,
      code: "PACKAGED_BACKEND_INTEGRITY_FAILED",
      error: integrityResult.error || "Packaged backend integrity verification failed.",
    };
  }

  return validateProjectPath(effectivePath);
}

function sanitizeAppConfig(config = {}) {
  const merged = mergeConfigWithDefaults(config);
  merged.general.backendProjectPath = normalizeStoredBackendProjectPath(
    merged.general.backendProjectPath
  );
  merged.advanced.imageProcessingMethod =
    merged.advanced?.imageProcessingMethod === "base64" ? "base64" : "path";
  merged.advanced.imageOutputNamingMode = IMAGE_OUTPUT_NAMING_MODES.includes(
    merged.advanced?.imageOutputNamingMode
  )
    ? merged.advanced.imageOutputNamingMode
    : "original";
  merged.advanced.imageOutputFixedPrefix =
    String(merged.advanced?.imageOutputFixedPrefix || "moonshine").trim() || "moonshine";
  merged.shortcuts = normalizeShortcutConfig(merged.shortcuts);
  if (app.isPackaged && isBundledBackendMode(merged.general.backendProjectPath)) {
    merged.general.modelPath = getPackagedModelsPath();
    merged.general.modelDir = "";
  }
  if (merged?.video && Object.prototype.hasOwnProperty.call(merged.video, "outputPath")) {
    delete merged.video.outputPath;
  }
  if (merged?.video && Object.prototype.hasOwnProperty.call(merged.video, "maxFrameCount")) {
    delete merged.video.maxFrameCount;
  }
  return merged;
}

// Validate configuration file format
function validateConfig(config) {
  try {
    // Validate required sections
    if (
      !config.general ||
      !config.fileManagement ||
      !config.advanced ||
      !config.ui ||
      !config.shortcuts ||
      !config.video
    ) {
      return false;
    }

    const port = config.general.backendPort;
    if (typeof port !== "number" || port < 1024 || port > 65535) {
      return false;
    }

    // Validate launch mode
    if (!["cuda", "cpu"].includes(config.general.launchMode)) {
      return false;
    }

    // Validate numeric fields
    const numFields = [
      config.advanced.imageHistoryLimit,
      config.advanced.imageWarningSize,
      config.advanced.stateSaveLimit,
    ];

    if (numFields.some((field) => typeof field !== "number" || field < 0)) {
      return false;
    }

    // Validate image processing method
    if (
      config.advanced?.imageProcessingMethod &&
      !["base64", "path"].includes(config.advanced.imageProcessingMethod)
    ) {
      return false;
    }

    if (
      config.advanced?.imageOutputNamingMode &&
      !IMAGE_OUTPUT_NAMING_MODES.includes(config.advanced.imageOutputNamingMode)
    ) {
      return false;
    }

    if (!String(config.advanced?.imageOutputFixedPrefix || "").trim()) {
      return false;
    }

    if (
      typeof config.video.historyLimit !== "number" ||
      Number.isNaN(config.video.historyLimit) ||
      config.video.historyLimit < 1 ||
      config.video.historyLimit > 50
    ) {
      return false;
    }

    if (
      typeof config.video.batchFrameCount !== "number" ||
      Number.isNaN(config.video.batchFrameCount) ||
      config.video.batchFrameCount < 1
    ) {
      return false;
    }

    if (
      config.video.frameExtractionFormat &&
      !["jpg", "jpeg", "png", "webp"].includes(
        String(config.video.frameExtractionFormat).toLowerCase()
      )
    ) {
      return false;
    }

    if (
      config.video.batchRetryCount !== undefined &&
      (typeof config.video.batchRetryCount !== "number" ||
        Number.isNaN(config.video.batchRetryCount) ||
        config.video.batchRetryCount < 1 ||
        config.video.batchRetryCount > 10)
    ) {
      return false;
    }

    if (
      config.video.failureRetentionCount !== undefined &&
      (typeof config.video.failureRetentionCount !== "number" ||
        Number.isNaN(config.video.failureRetentionCount) ||
        config.video.failureRetentionCount < 1 ||
        config.video.failureRetentionCount > 50)
    ) {
      return false;
    }

    if (!validateShortcutConfig(config.shortcuts)) {
      return false;
    }
    return true;
  } catch (error) {
    console.error("Configuration validation failed:", error);
    return false;
  }
}

// Load configuration file
function loadAppConfig() {
  try {
    const configPath = getConfigPath();

    if (fs.existsSync(configPath)) {
      const configData = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const sanitizedConfig = sanitizeAppConfig(configData);
      if (validateConfig(sanitizedConfig)) {
        globalConfig = sanitizedConfig;
        if (JSON.stringify(configData) !== JSON.stringify(sanitizedConfig)) {
          fs.writeFileSync(configPath, JSON.stringify(sanitizedConfig, null, 2));
        }
        console.log("Configuration file loaded successfully");
      } else {
        console.warn("Configuration file format is invalid, falling back to defaults");
        createDefaultConfig();
      }
    } else {
      console.log("Configuration file does not exist. Creating default configuration");
      createDefaultConfig();
    }

    // Update global runtime configuration
    global.appConfig = {
      ...sanitizeAppConfig(globalConfig),
      api: {
        port: globalConfig.general.backendPort,
        baseURL: `http://localhost:${globalConfig.general.backendPort}`,
      },
    };
    global.projectPath = globalConfig.general.backendProjectPath || "";
  } catch (error) {
    console.error("Failed to load configuration:", error);
    createDefaultConfig();
  }
}

// Create default configuration file
function createDefaultConfig() {
  try {
    const configPath = getConfigPath();

    // Initialize default paths
    const userDataPath = app.getPath("userData");
    const userPath = app.getPath("home");
    DEFAULT_CONFIG.fileManagement.downloadPath = path.join(
      userDataPath,
      "downloads"
    );
    DEFAULT_CONFIG.fileManagement.tempPath = path.join(userDataPath, "temp");
    DEFAULT_CONFIG.general.modelPath = app.isPackaged
      ? getPackagedModelsPath()
      : path.join(userPath, ".cache", "torch", "hub", "checkpoints");
    DEFAULT_CONFIG.general.modelDir = "";
    DEFAULT_CONFIG.general.backendProjectPath = getDefaultBackendProjectPath();
    DEFAULT_CONFIG.general.defaultModel = "lama";
    DEFAULT_CONFIG.video.tempFramesPath = path.join(
      userDataPath,
      "temp",
      "video_frames"
    );
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
    globalConfig = sanitizeAppConfig(DEFAULT_CONFIG);
    global.projectPath = globalConfig.general.backendProjectPath || "";

    [
      DEFAULT_CONFIG.fileManagement.downloadPath,
      DEFAULT_CONFIG.fileManagement.tempPath,
    ].forEach((dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });

    console.log("Default configuration file created successfully");
  } catch (error) {
    console.error("Failed to create default configuration:", error);
  }
}

// IPC handler - get app config
ipcMain.handle("get-app-config", async () => {
  return global.appConfig || globalConfig;
});

// IPC handler - save app config
ipcMain.handle("save-app-config", async (event, newConfig) => {
  try {
    if (!newConfig || typeof newConfig !== "object") {
      console.error("Invalid configuration payload:", newConfig);
      return { success: false, error: "Invalid configuration payload" };
    }
    const sanitizedConfig = sanitizeAppConfig(newConfig);
    if (!validateConfig(sanitizedConfig)) {
      console.error("Configuration validation failed:", newConfig);
      return { success: false, error: "Invalid configuration payload" };
    }
    const configPath = getConfigPath();
    console.log("Saving configuration to:", configPath);
    fs.writeFileSync(configPath, JSON.stringify(sanitizedConfig, null, 2));
    // Refresh global runtime configuration
    globalConfig = sanitizedConfig;
    global.appConfig = {
      ...globalConfig,
      api: {
        port: globalConfig.general.backendPort,
        baseURL: `http://localhost:${globalConfig.general.backendPort}`,
      },
    };
    global.projectPath = globalConfig.general.backendProjectPath || "";
    console.log("Configuration saved successfully");
    return { success: true };
  } catch (error) {
    console.error("Failed to save configuration:", error);
    return { success: false, error: error.message };
  }
});

// IPC handler - save app state
ipcMain.handle("save-app-state", async (event, stateData) => {
  try {
    const statePath = path.join(app.getPath("userData"), "app-state.json");
    const stateSize = Buffer.byteLength(JSON.stringify(stateData), "utf8");
    const limitMB = globalConfig.advanced.stateSaveLimit;
    const limitBytes = limitMB * 1024 * 1024;

    if (stateSize > limitBytes) {
      return {
        success: false,
        error: `State data is too large (${(stateSize / 1024 / 1024).toFixed(
          2
        )}MB > ${limitMB}MB)`,
        oversized: true,
      };
    }
    fs.writeFileSync(statePath, JSON.stringify(stateData, null, 2));
    return { success: true };
  } catch (error) {
    console.error("Failed to save app state:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("load-app-state", async () => {
  try {
    const statePath = path.join(app.getPath("userData"), "app-state.json");

    if (fs.existsSync(statePath)) {
      const stateData = JSON.parse(fs.readFileSync(statePath, "utf8"));
      return { success: true, data: stateData };
    } else {
      return { success: true, data: null };
    }
  } catch (error) {
    console.error("Failed to load app state:", error);
    return { success: false, error: error.message };
  }
});

function clearAppStateFile() {
  const statePath = path.join(app.getPath("userData"), "app-state.json");
  if (fs.existsSync(statePath)) {
    fs.unlinkSync(statePath);
  }
}

ipcMain.handle("clear-app-state", async () => {
  try {
    clearAppStateFile();
    return { success: true };
  } catch (error) {
    console.error("Failed to clear app state:", error);
    return { success: false, error: error.message };
  }
});
ipcMain.handle("check-app-state-exists", async () => {
  try {
    const statePath = path.join(app.getPath("userData"), "app-state.json");
    return fs.existsSync(statePath);
  } catch (error) {
    console.error("Failed to check whether app state exists:", error);
    return false;
  }
});

// IPC handler - save file
const activeFileWriteStreams = new Map();
let nextFileWriteStreamId = 1;

const resolveWritableFilePath = (filePath) => {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  if (!fs.existsSync(filePath)) {
    return filePath;
  }

  const fileExt = path.extname(filePath);
  const baseName = path.basename(filePath, fileExt);
  const dirName = path.dirname(filePath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dirName, `${baseName}_${timestamp}${fileExt}`);
};

const waitForWriteStreamOpen = (stream) =>
  new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.removeListener("open", onOpen);
      stream.removeListener("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };

    stream.once("open", onOpen);
    stream.once("error", onError);
  });

const writeChunkToStream = (stream, chunk) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      stream.removeListener("error", onError);
      stream.removeListener("drain", onDrain);
    };
    const finalize = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onError = (error) => finalize(reject, error);
    const onDrain = () => finalize(resolve);

    stream.once("error", onError);
    let canContinue = false;
    canContinue = stream.write(Buffer.from(chunk), (error) => {
      if (error) {
        finalize(reject, error);
        return;
      }

      if (canContinue) {
        finalize(resolve);
      }
    });

    if (!canContinue) {
      stream.once("drain", onDrain);
    }
  });

const finishWriteStream = (stream) =>
  new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.removeListener("finish", onFinish);
      stream.removeListener("error", onError);
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };

    stream.once("finish", onFinish);
    stream.once("error", onError);
    stream.end();
  });

const saveFileHandler = async (event, { filePath, blob }) => {
  try {
    filePath = resolveWritableFilePath(filePath);

    fs.writeFileSync(filePath, Buffer.from(blob));

    return filePath;
  } catch (error) {
    console.error("Failed to save file:", error);
    throw error;
  }
};
ipcMain.handle("save-file", saveFileHandler);
ipcMain.handle("saveFile", saveFileHandler);
ipcMain.handle("open-file-write-stream", async (event, filePath) => {
  try {
    const resolvedFilePath = resolveWritableFilePath(filePath);
    const stream = fs.createWriteStream(resolvedFilePath);
    await waitForWriteStreamOpen(stream);

    const streamId = `file_stream_${Date.now()}_${nextFileWriteStreamId++}`;
    activeFileWriteStreams.set(streamId, {
      stream,
      filePath: resolvedFilePath,
    });

    return {
      success: true,
      streamId,
      filePath: resolvedFilePath,
    };
  } catch (error) {
    console.error("Failed to open file write stream:", error);
    return { success: false, error: error.message };
  }
});
ipcMain.handle("write-file-stream-chunk", async (event, { streamId, chunk }) => {
  const session = activeFileWriteStreams.get(streamId);
  if (!session) {
    return { success: false, error: "File write stream is not open." };
  }

  try {
    if (chunk) {
      await writeChunkToStream(session.stream, chunk);
    }
    return { success: true };
  } catch (error) {
    console.error("Failed to write file stream chunk:", error);
    return { success: false, error: error.message };
  }
});
ipcMain.handle("close-file-write-stream", async (event, streamId) => {
  const session = activeFileWriteStreams.get(streamId);
  if (!session) {
    return { success: false, error: "File write stream is not open." };
  }

  activeFileWriteStreams.delete(streamId);
  try {
    await finishWriteStream(session.stream);
    return {
      success: true,
      filePath: session.filePath,
    };
  } catch (error) {
    console.error("Failed to close file write stream:", error);
    return { success: false, error: error.message };
  }
});
ipcMain.handle("abort-file-write-stream", async (event, streamId) => {
  const session = activeFileWriteStreams.get(streamId);
  if (!session) {
    return { success: true };
  }

  activeFileWriteStreams.delete(streamId);
  try {
    session.stream.destroy();
    if (fs.existsSync(session.filePath)) {
      fs.rmSync(session.filePath, { force: true });
    }
    return { success: true };
  } catch (error) {
    console.error("Failed to abort file write stream:", error);
    return { success: false, error: error.message };
  }
});
// IPC handler - select directory
ipcMain.handle("select-directory", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "Select save location",
  });
  return { canceled, filePaths };
});

ipcMain.handle("open-external-link", async (event, url) => {
  try {
    await shell.openExternal(url);
    return true;
  } catch (err) {
    console.error("Failed to open external link:", err);
    return false;
  }
});
// Compatibility handler for sync calls from older code
ipcMain.on("open-external-link", (event, url) => {
  shell.openExternal(url).catch((err) => {
    console.error("Failed to open external link:", err);
  });
  event.returnValue = true; // Required for sendSync callers.
});
// IPC handler - get resources path
ipcMain.handle("get-resources-path", () => {
  try {
    return getResourcesRootPath();
  } catch (error) {
    console.error("Failed to get resources path:", error);
    return "./resources";
  }
});

// IPC handler - read file
ipcMain.handle("read-file", async (event, filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: `File does not exist: ${filePath}` };
    }

    const stats = fs.statSync(filePath);
    const buffer = fs.readFileSync(filePath);

    return {
      success: true,
      data: {
        name: path.basename(filePath),
        size: stats.size,
        type: getMimeType(filePath),
        lastModified: stats.mtime.getTime(),
        buffer: Array.from(buffer),
        path: filePath,
      },
    };
  } catch (error) {
    console.error("Failed to read file:", error);
    return { success: false, error: error.message };
  }
});
// IPC handler - show missing files warning
ipcMain.on("show-missing-files", (event, missingFiles) => {
  if (missingFiles && missingFiles.length > 0) {
    const message = `The following files are missing:\n${missingFiles.join("\n")}`;
    dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Missing Files",
      message: message,
      buttons: ["OK"],
    });
  }
});

// IPC handler - ensure directory exists
ipcMain.handle("ensure-directory", async (event, dirPath) => {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    return { success: true };
  } catch (error) {
    console.error("Failed to create directory:", error);
    return { success: false, error: error.message };
  }
});

// IPC handler - delete file
ipcMain.handle("delete-file", async (event, filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return { success: true };
  } catch (error) {
    console.error("Failed to delete file:", error);
    return { success: false, error: error.message };
  }
});
// IPC handler - copy file
ipcMain.handle("copy-file", async (event, { source, target }) => {
  try {
    // Check whether the source file exists
    if (!fs.existsSync(source)) {
      throw new Error(`Source file does not exist: ${source}`);
    }

    // Ensure the target directory exists
    const targetDir = path.dirname(target);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    let finalTarget = target;
    if (fs.existsSync(target)) {
      const fileExt = path.extname(target);
      const baseName = path.basename(target, fileExt);
      const dirName = path.dirname(target);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      finalTarget = path.join(dirName, `${baseName}_${timestamp}${fileExt}`);
    }

    // Copy file
    fs.copyFileSync(source, finalTarget);

    console.log(`File copied successfully: ${source} -> ${finalTarget}`);
    return { success: true, targetPath: finalTarget };
  } catch (error) {
    console.error("Failed to copy file:", error);
    return { success: false, error: error.message };
  }
});
// IPC handler - select file
ipcMain.handle("select-file", async (event, options = {}) => {
  const dialogOptions = {
    title: options.title || "Select File",
    filters: options.filters || [],
    properties: options.properties || ["openFile"],
  };

  const { canceled, filePaths } = await dialog.showOpenDialog(dialogOptions);
  return { canceled, filePaths };
});

ipcMain.handle("select-folder", async (event, options = {}) => {
  const dialogOptions = {
    title: options.title || "Select Folder",
    properties: ["openDirectory"],
  };

  const { canceled, filePaths } = await dialog.showOpenDialog(dialogOptions);
  return { canceled, filePaths };
});

// IPC handler - check Python environment
ipcMain.handle("check-python", async (event) => {
  const sendLog = (message, type = "info") => {
    event.sender.send("backend-output", { message, type });
  };

  try {
    // Snapshot current system environment variables
    const systemEnv = { ...process.env };
    sendLog("Checking Python environment...", "info");

    // Windows-specific detection flow
    if (os.platform() === "win32") {
      // Try common Python commands first
      const pythonCommands = ["python", "py", "python3"];
      sendLog(`Trying Python commands: ${pythonCommands.join(", ")}`, "info");

      for (const cmd of pythonCommands) {
        try {
          sendLog(`Trying command: ${cmd} --version`, "info");
          const { stdout } = await execAsync(`${cmd} --version`, {
            env: systemEnv,
            shell: true,
            timeout: 10000,
          });
          if (stdout) {
            sendLog(
              `Command ${cmd} --version succeeded: ${stdout.trim()}`,
              "success"
            );
            return {
              success: true,
              version: stdout.trim(),
              type: "python",
              command: cmd,
            };
          }
        } catch (cmdError) {
          sendLog(`Command ${cmd} failed: ${cmdError.message}`, "warning");
          continue;
        }
      }

      // Fall back to common installation paths
      const commonPaths = [
        "C:\\Python311\\python.exe",
        "C:\\Python310\\python.exe",
        "C:\\Python39\\python.exe",
        "C:\\Users\\" +
          os.userInfo().username +
          "\\AppData\\Local\\Programs\\Python\\Python311\\python.exe",
        "C:\\Users\\" +
          os.userInfo().username +
          "\\AppData\\Local\\Programs\\Python\\Python310\\python.exe",
      ];

      sendLog("Checking common Python installation paths...", "info");
      for (const pythonPath of commonPaths) {
        try {
          sendLog(`Checking path: ${pythonPath}`, "info");
          if (fs.existsSync(pythonPath)) {
            sendLog(`Found Python executable: ${pythonPath}`, "success");
            const { stdout } = await execAsync(`"${pythonPath}" --version`, {
              env: systemEnv,
              shell: true,
              timeout: 10000,
            });
            if (stdout) {
              sendLog(`Python version check succeeded: ${stdout.trim()}`, "success");
              return {
                success: true,
                version: stdout.trim(),
                type: "python",
                path: pythonPath,
              };
            }
          } else {
            sendLog(`Path does not exist: ${pythonPath}`, "warning");
          }
        } catch (pathError) {
          sendLog(
            `Path check failed for ${pythonPath}: ${pathError.message}`,
            "warning"
          );
          continue;
        }
      }
    } else {
      // Unix-like platforms
      sendLog("Checking Python environment on Unix-like platforms...", "info");
      try {
        sendLog("Trying command: python --version", "info");
        const { stdout: pythonStdout } = await execAsync("python --version", {
          env: systemEnv,
          shell: true,
          timeout: 10000,
        });
        if (pythonStdout) {
          sendLog(`python command succeeded: ${pythonStdout.trim()}`, "success");
          return {
            success: true,
            version: pythonStdout.trim(),
            type: "python",
          };
        }
      } catch (pythonError) {
        sendLog(`python command failed: ${pythonError.message}`, "warning");
        try {
          sendLog("Trying command: python3 --version", "info");
          const { stdout: python3Stdout } = await execAsync(
            "python3 --version",
            {
              env: systemEnv,
              shell: true,
              timeout: 10000,
            }
          );
          if (python3Stdout) {
            sendLog(`python3 command succeeded: ${python3Stdout.trim()}`, "success");
            return {
              success: true,
              version: python3Stdout.trim(),
              type: "python",
            };
          }
        } catch (python3Error) {
          sendLog(`python3 command failed: ${python3Error.message}`, "warning");
          // Continue by checking conda
        }
      }
    }

    // Fall back to conda detection
    sendLog("Checking conda environment...", "info");
    try {
      const { stdout: condaStdout } = await execAsync("conda -V", {
        env: systemEnv,
        shell: true,
        timeout: 10000,
      });
      if (condaStdout) {
        sendLog(`Found conda: ${condaStdout.trim()}`, "success");
        try {
          // Check whether the moonshine-image environment exists
          sendLog("Checking moonshine-image conda environment...", "info");
          const { stdout: envCheckStdout } = await execAsync("conda env list", {
            env: systemEnv,
            shell: true,
            timeout: 10000,
          });

          if (!envCheckStdout.includes("moonshine-image")) {
            // Create the moonshine-image environment if needed
            sendLog("Creating moonshine-image conda environment...", "info");
            await execAsync(
              "conda create -n moonshine-image python=3.11.5 -y",
              {
                env: systemEnv,
                shell: true,
                timeout: 300000,
              }
            );
            sendLog("moonshine-image environment created successfully", "success");
          } else {
            sendLog("moonshine-image environment already exists", "success");
          }

          // Activate the environment and verify Python version
          sendLog("Activating moonshine-image and checking Python version...", "info");
          const activateCmd =
            os.platform() === "win32"
              ? "conda activate moonshine-image && python --version"
              : "source activate moonshine-image && python --version";

          const { stdout: envPythonStdout } = await execAsync(activateCmd, {
            env: systemEnv,
            shell: true,
            timeout: 30000,
          });

          sendLog(
            `Conda environment Python version: ${envPythonStdout.trim()}`,
            "success"
          );
          return {
            success: true,
            version: envPythonStdout.trim(),
            type: "conda",
          };
        } catch (envError) {
          sendLog(`Conda environment operation failed: ${envError.message}`, "error");
          return {
            success: false,
            error: `Found conda (${condaStdout.trim()}), but creating or activating the environment failed: ${
              envError.message
            }`,
          };
        }
      }
    } catch (condaError) {
      sendLog(`Conda check failed: ${condaError.message}`, "warning");
      sendLog("No usable Python environment was detected", "error");
      return {
        success: false,
        error: `No usable Python environment was detected. Please make sure Python is installed and added to PATH. Details: ${condaError.message}`,
      };
    }
  } catch (error) {
    sendLog(`Unexpected error while checking Python environment: ${error.message}`, "error");
    return {
      success: false,
      error: `Python environment check failed: ${error.message}`,
    };
  }
});

// IPC handler - set Python environment variables
ipcMain.handle("set-python-env", async (event, pythonPath) => {
  try {
    const currentEnv = process.env.PATH || "";
    if (!currentEnv.includes(pythonPath)) {
      // Append the path only when it is not already present
      process.env.PATH = `${pythonPath};${currentEnv}`;
    }
    return { success: true, message: "Python environment variables updated successfully" };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// IPC handler - check conda environment
ipcMain.handle("check-conda-venv", async () => {
  try {
    // Snapshot current system environment variables
    const systemEnv = { ...process.env };

    // Check whether the moonshine-image environment exists
    const { stdout } = await execAsync("conda env list", {
      env: systemEnv,
      shell: true,
      timeout: 10000,
    });

    const envExists = stdout.includes("moonshine-image");
    return {
      success: envExists,
      message: envExists ? "Conda environment exists" : "Conda environment does not exist",
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to check conda environment: ${error.message}`,
    };
  }
});

// IPC handler - check conda dependencies
ipcMain.handle("check-conda-dependencies", async () => {
  try {
    // Snapshot current system environment variables
    const systemEnv = { ...process.env };

    const activateCmd =
      os.platform() === "win32"
        ? "conda activate moonshine-image && conda list"
        : "source activate moonshine-image && conda list";

    const { stdout } = await execAsync(activateCmd, {
      env: systemEnv,
      shell: true,
      timeout: 30000,
    });

    // Treat a populated conda list output as a basic dependency check
    return { success: stdout.split("\n").length > 10, message: stdout };
  } catch (error) {
    return { success: false, error: `Failed to check conda dependencies: ${error.message}` };
  }
});
// IPC handler - validate project path
ipcMain.handle("check-project", async (event, selectPath) => {
  try {
    const result = await resolveValidatedProjectPath(selectPath || global.projectPath);
    if (!result.success) {
      return result;
    }

    global.projectPath = result.path;
    return {
      success: true,
      path: result.path,
      backendMode: isBundledBackendMode(result.path) ? "bundled" : "external",
      defaultProjectPath: getDefaultBackendProjectPath(),
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});

ipcMain.handle("prepare-project-python", async (event, selectPath) => {
  const sendLog = (message, type = "info") => {
    event.sender.send("backend-output", { message, type });
  };

  try {
    const projectResult = await resolveValidatedProjectPath(
      selectPath || global.projectPath
    );
    if (!projectResult.success) {
      return projectResult;
    }

    global.projectPath = projectResult.path;
    const workingPath = projectResult.path;
    sendLog(`Backend project path: ${workingPath}`, "info");

    if (isBundledBackendMode(workingPath)) {
      sendLog("Using bundled offline backend mode.", "info");
      return ensureBundledRuntimeReady(sendLog);
    }

    let existingVenv = await getUsableProjectVenvInfo(workingPath);
    if (existingVenv.exists) {
      if (!existingVenv.valid) {
        if (canAutoRepairProjectVenv(workingPath, existingVenv)) {
          sendLog(
            `Detected an unusable packaged virtual environment at ${existingVenv.venvPath}. Removing it before repair...`,
            "warning"
          );
          removeProjectVenv(existingVenv);
          existingVenv = await getUsableProjectVenvInfo(workingPath);
        } else {
          const manualGuide = buildManualVenvGuide(workingPath);
          return {
            success: false,
            code: "INVALID_PROJECT_VENV",
            error:
              existingVenv.error ||
              "A virtual environment folder exists in the backend project, but it is invalid. Please fix it manually.",
            manualGuide,
            venvPath: existingVenv.venvPath,
            venvName: existingVenv.venvName,
          };
        }
      }

      if (existingVenv.exists && existingVenv.valid) {
        return {
          success: true,
          backendMode: "external",
          path: workingPath,
          pythonVersion: existingVenv.pythonVersion || "",
          pythonSource: "project virtual environment",
          venvPath: existingVenv.venvPath,
          venvName: existingVenv.venvName,
          pythonPath: existingVenv.pythonPath,
        };
      }
    }

    const systemPython = await detectSystemPython();
    if (systemPython.success) {
      if (!isSystemPythonVersionSupported(systemPython.version)) {
        const manualGuide = buildManualVenvGuide(workingPath);
        return {
          success: false,
          code: "SYSTEM_PYTHON_UNSUPPORTED",
          error: `Detected system Python ${systemPython.version.text}. Supported range is 3.10.x to 3.12.x. Please manually create a Python ${TARGET_PYTHON_VERSION} .venv inside the backend project.`,
          manualGuide,
          detectedPythonVersion: systemPython.version.text,
        };
      }

      const venvInfo = await createProjectVenvWithPython(
        workingPath,
        systemPython.command,
        sendLog
      );
      const versionResult = await getPythonVersionFromCommand(
        quoteArg(venvInfo.pythonPath)
      );
      return {
        success: true,
        backendMode: "external",
        path: workingPath,
        pythonVersion: versionResult.success ? versionResult.version.text : "",
        pythonSource: "virtual environment created from system Python",
        venvPath: venvInfo.venvPath,
        venvName: venvInfo.venvName,
        pythonPath: venvInfo.pythonPath,
      };
    }

    const condaResult = await detectConda();
    if (condaResult.success) {
      const venvInfo = await bootstrapProjectVenvWithConda(workingPath, sendLog);
      const versionResult = await getPythonVersionFromCommand(
        quoteArg(venvInfo.pythonPath)
      );
      return {
        success: true,
        backendMode: "external",
        path: workingPath,
        pythonVersion: versionResult.success ? versionResult.version.text : "",
        pythonSource: "virtual environment bootstrapped from conda",
        venvPath: venvInfo.venvPath,
        venvName: venvInfo.venvName,
        pythonPath: venvInfo.pythonPath,
      };
    }

    sendLog(
      `No system Python or conda was detected. Trying to install Python ${TARGET_PYTHON_VERSION} automatically...`,
      "warning"
    );
    const installResult = await installPython3115(sendLog);
    if (installResult.success) {
      const detectedAfterInstall = await detectSystemPython();
      if (
        detectedAfterInstall.success &&
        isSystemPythonVersionSupported(detectedAfterInstall.version)
      ) {
        const venvInfo = await createProjectVenvWithPython(
          workingPath,
          detectedAfterInstall.command,
          sendLog
        );
        const versionResult = await getPythonVersionFromCommand(
          quoteArg(venvInfo.pythonPath)
        );
        return {
          success: true,
          backendMode: "external",
          path: workingPath,
          pythonVersion: versionResult.success ? versionResult.version.text : "",
          pythonSource: "virtual environment created after installing Python",
          venvPath: venvInfo.venvPath,
          venvName: venvInfo.venvName,
          pythonPath: venvInfo.pythonPath,
        };
      }
    }

    const manualGuide = buildManualVenvGuide(workingPath);
    return {
      success: false,
      code: "PYTHON_AUTO_SETUP_FAILED",
      error: `Automatic Python environment setup failed. Please install Python ${TARGET_PYTHON_VERSION} manually and create .venv in the backend project.`,
      manualGuide,
    };
  } catch (error) {
    return {
      success: false,
      code: "PREPARE_PROJECT_PYTHON_FAILED",
      error: error.message,
    };
  }
});

// IPC set project path
ipcMain.handle("set-project-path", async (event, selectPath) => {
  try {
    const normalizedPath = normalizeStoredBackendProjectPath(selectPath);
    const integrityResult = await ensurePackagedBackendIntegrity(normalizedPath);
    if (!integrityResult.success) {
      return {
        success: false,
        error: integrityResult.error || "Packaged backend integrity verification failed.",
      };
    }
    if (fs.existsSync(normalizedPath)) {
      global.projectPath = normalizedPath;
      return {
        success: true,
        path: normalizedPath,
        backendMode: isBundledBackendMode(normalizedPath) ? "bundled" : "external",
      };
    }
    return {
      success: false,
      error: "Backend project path does not exist.",
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});
ipcMain.handle("check-venv", async () => {
  try {
    if (!global.projectPath) {
      return { success: false, error: "Backend project path is not set." };
    }

    if (isBundledBackendMode(global.projectPath)) {
      const bundledResult = await ensureBundledRuntimeReady();
      if (!bundledResult.success) {
        return bundledResult;
      }

      return {
        success: true,
        exists: true,
        valid: true,
        venvPath: bundledResult.venvPath,
        venvName: bundledResult.venvName,
      };
    }

    const integrityResult = await ensurePackagedBackendIntegrity(global.projectPath);
    if (!integrityResult.success) {
      return integrityResult;
    }

    const venvInfo = await getUsableProjectVenvInfo(global.projectPath);
    return {
      success: venvInfo.exists && venvInfo.valid,
      exists: venvInfo.exists,
      valid: venvInfo.valid,
      venvPath: venvInfo.venvPath,
      venvName: venvInfo.venvName,
      error: venvInfo.valid ? undefined : venvInfo.error,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});

// IPC handler - check project dependencies
ipcMain.handle("check-dependencies", async () => {
  try {
    if (!global.projectPath) {
      return { success: false, error: "Backend project path is not set." };
    }

    if (isBundledBackendMode(global.projectPath)) {
      const bundledResult = await ensureBundledRuntimeReady();
      if (!bundledResult.success) {
        return bundledResult;
      }

      try {
        await execCommand(
          `${quoteArg(bundledResult.pythonPath)} -c "import fastapi,uvicorn,numpy,PIL,torch,diffusers,transformers"`,
          {
            cwd: bundledResult.path,
            timeout: 30000,
            env: getBundledRuntimeCommandEnv(),
          }
        );
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }

    const integrityResult = await ensurePackagedBackendIntegrity(global.projectPath);
    if (!integrityResult.success) {
      return integrityResult;
    }

    const venvInfo = await getUsableProjectVenvInfo(global.projectPath);
    if (!venvInfo.exists || !venvInfo.valid) {
      return { success: false, error: venvInfo.error };
    }

    try {
      await execCommand(
        `${quoteArg(venvInfo.pythonPath)} -c "import fastapi,uvicorn,numpy,PIL"`,
        {
          cwd: global.projectPath,
          timeout: 30000,
        }
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});

// Helper - install Python 3.11.5
async function installPython3115(sendLog) {
  try {
    const pythonUrls = {
      win32: "https://www.python.org/ftp/python/3.11.5/python-3.11.5-amd64.exe",
      darwin:
        "https://www.python.org/ftp/python/3.11.5/python-3.11.5-macos11.pkg",
      linux: "https://www.python.org/ftp/python/3.11.5/Python-3.11.5.tgz",
    };
    const platform = os.platform();
    const downloadUrl = pythonUrls[platform];
    if (!downloadUrl) {
      return {
        success: false,
        error: `Automatic installation is not supported on this platform. Please install Python ${TARGET_PYTHON_VERSION} manually.`,
      };
    }

    const downloadDir = path.join(app.getPath("temp"), "moonshine-python-installer");
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }
    const fileName = path.basename(downloadUrl);
    const filePath = path.join(downloadDir, fileName);

    sendLog?.(`Downloading Python installer: ${downloadUrl}`, "info");
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filePath);
      https
        .get(downloadUrl, (response) => {
          response.pipe(file);
          file.on("finish", () => {
            file.close();
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("python-install-path", filePath);
            }
            resolve();
          });
        })
        .on("error", (err) => {
          fs.unlink(filePath, () => {});
          reject(err);
        });
    });

    sendLog?.("Python installer downloaded. Starting installation...", "info");
    if (platform === "win32") {
      await execCommand(
        `${quoteArg(filePath)} /quiet InstallAllUsers=1 PrependPath=1 Include_test=0`,
        { timeout: 600000 }
      );
    } else if (platform === "darwin") {
      await execCommand(`sudo installer -pkg ${quoteArg(filePath)} -target /`, {
        timeout: 600000,
      });
    } else {
      return {
        success: false,
        error: `Automatic installation is not supported on Linux. Please install Python ${TARGET_PYTHON_VERSION} manually.`,
      };
    }

    fs.unlink(filePath, () => {});
    return {
      success: true,
      message: `Python ${TARGET_PYTHON_VERSION} installed successfully.`,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}

ipcMain.handle("install-python", async () => {
  return installPython3115();
});

// IPC create venv
ipcMain.handle("create-venv", async (event, projectPath) => {
  const sendLog = (message, type = "info") => {
    event.sender.send("backend-output", { message, type });
  };

  try {
    const projectResult = await resolveValidatedProjectPath(
      projectPath || global.projectPath
    );
    if (!projectResult.success) {
      return projectResult;
    }

    global.projectPath = projectResult.path;
    const workingPath = projectResult.path;
    if (isBundledBackendMode(workingPath)) {
      const bundledResult = await ensureBundledRuntimeReady(sendLog);
      if (!bundledResult.success) {
        return bundledResult;
      }

      return {
        success: true,
        message: "Bundled offline runtime is already prepared.",
      };
    }

    let venvInfo = await getUsableProjectVenvInfo(workingPath);
    if (venvInfo.exists) {
      if (!venvInfo.valid) {
        if (canAutoRepairProjectVenv(workingPath, venvInfo)) {
          sendLog(
            `Detected an unusable packaged virtual environment at ${venvInfo.venvPath}. Removing it before recreation...`,
            "warning"
          );
          removeProjectVenv(venvInfo);
          venvInfo = await getUsableProjectVenvInfo(workingPath);
        } else {
          return {
            success: false,
            code: "INVALID_PROJECT_VENV",
            error:
              venvInfo.error ||
              "A virtual environment folder exists in the backend project, but it is invalid. Please fix it manually.",
            manualGuide: buildManualVenvGuide(workingPath),
          };
        }
      }
      if (venvInfo.exists && venvInfo.valid) {
        return {
          success: true,
          message: "Project virtual environment already exists.",
        };
      }
    }

    const systemPython = await detectSystemPython();
    if (!systemPython.success) {
      return {
        success: false,
        code: "SYSTEM_PYTHON_NOT_FOUND",
        error: "No system Python was detected.",
      };
    }

    if (!isSystemPythonVersionSupported(systemPython.version)) {
      return {
        success: false,
        code: "SYSTEM_PYTHON_UNSUPPORTED",
        error: `Detected system Python ${systemPython.version.text}. Please manually create a Python ${TARGET_PYTHON_VERSION} .venv.`,
        manualGuide: buildManualVenvGuide(workingPath),
      };
    }

    await createProjectVenvWithPython(workingPath, systemPython.command, sendLog);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});

// IPC create conda venv
ipcMain.handle("create-conda-venv", async (event) => {
  const sendLog = (message, type = "info") => {
    event.sender.send("backend-output", { message, type });
  };

  try {
    const systemEnv = { ...process.env };
    sendLog("Creating conda virtual environment...", "info");

    const { stdout: envListStdout } = await execAsync("conda env list", {
      env: systemEnv,
      shell: true,
      timeout: 10000,
    });

    if (!envListStdout.includes("moonshine-image")) {
      sendLog("Creating moonshine-image conda environment...", "info");
      await execAsync("conda create -n moonshine-image python=3.11.5 -y", {
        env: systemEnv,
        shell: true,
        timeout: 300000,
      });
      sendLog("moonshine-image environment created successfully", "success");
    } else {
      sendLog("moonshine-image environment already exists", "success");
    }

    return { success: true };
  } catch (error) {
    sendLog(`Failed to create conda virtual environment: ${error.message}`, "error");
    return { success: false, error: error.message };
  }
});
// IPC handler - install dependencies
ipcMain.handle("install-dependencies", async (event, projectPath) => {
  try {
    const projectResult = await resolveValidatedProjectPath(projectPath || global.projectPath);
    if (!projectResult.success) {
      return projectResult;
    }

    const workingPath = projectResult.path;
    if (isBundledBackendMode(workingPath)) {
      const bundledResult = await ensureBundledRuntimeReady((message, type = "info") => {
        mainWindow.webContents.send("backend-output", { type, message });
      });
      if (!bundledResult.success) {
        return bundledResult;
      }

      mainWindow.webContents.send("backend-output", {
        type: "success",
        message: "Bundled offline runtime already includes backend dependencies.",
      });
      return {
        success: true,
        message: "Bundled offline runtime already includes backend dependencies.",
      };
    }

    const venvInfo = await getUsableProjectVenvInfo(workingPath);
    if (!venvInfo.exists || !venvInfo.valid) {
      return {
        success: false,
        error:
          venvInfo.error ||
          "Project virtual environment is missing or invalid. Create or repair .venv first.",
      };
    }

    const venvPython = venvInfo.pythonPath;
    // const pipCommand = `"${venvPython}" -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple`;

    mainWindow.webContents.send("backend-output", {
      type: "info",
      message: "Starting dependency installation...",
    });

    const installProcess = spawn(
      venvPython,
      [
        "-m",
        "pip",
        "install",
        "-r",
        "requirements.txt",
        "-i",
        "https://pypi.tuna.tsinghua.edu.cn/simple",
      ],
      {
        cwd: workingPath,
        stdio: "pipe",
      }
    );

    // Stream install output in real time
    installProcess.stdout.on("data", (data) => {
      mainWindow.webContents.send("backend-output", {
        type: "info",
        message: data.toString(),
      });
    });

    installProcess.stderr.on("data", (data) => {
      mainWindow.webContents.send("backend-output", {
        type: "warning",
        message: data.toString(),
      });
    });

    return new Promise((resolve) => {
      installProcess.on("close", (code) => {
        if (code === 0) {
          mainWindow.webContents.send("backend-output", {
            type: "success",
            message: "Dependencies installed successfully",
          });
          resolve({ success: true, message: "Dependencies installed successfully" });
        } else {
          mainWindow.webContents.send("backend-output", {
            type: "error",
            message: `Dependency installation failed. Exit code: ${code}`,
          });
          resolve({ success: false, error: `Dependency installation failed. Exit code: ${code}` });
        }
      });
    });
  } catch (error) {
    mainWindow.webContents.send("backend-output", {
      type: "error",
      message: `Dependency installation failed: ${error.message}`,
    });
    return {
      success: false,
      error: error.message,
      stderr: error.stderr,
    };
  }
});
// IPC handler - install conda dependencies
ipcMain.handle("install-conda-dependencies", async (event) => {
  const sendLog = (message, type = "info") => {
    event.sender.send("backend-output", { message, type });
  };

  try {
    if (!global.projectPath) {
      return { success: false, error: "Project path is not set." };
    }

    const systemEnv = { ...process.env };
    sendLog("Starting conda dependency installation...", "info");

    // Activate the environment and install dependencies
    const activateAndInstallCmd =
      os.platform() === "win32"
        ? `conda activate moonshine-image && pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple`
        : `source activate moonshine-image && pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple`;

    const installProcess = spawn("cmd", ["/c", activateAndInstallCmd], {
      cwd: global.projectPath,
      stdio: "pipe",
      env: systemEnv,
      shell: true,
    });

    // Stream install output in real time
    installProcess.stdout.on("data", (data) => {
      sendLog(data.toString(), "info");
    });

    installProcess.stderr.on("data", (data) => {
      sendLog(data.toString(), "warning");
    });

    return new Promise((resolve) => {
      installProcess.on("close", (code) => {
        if (code === 0) {
          sendLog("Conda dependencies installed successfully", "success");
          resolve({ success: true });
        } else {
          sendLog(`Conda dependency installation failed. Exit code: ${code}`, "error");
          resolve({ success: false, error: `Dependency installation failed. Exit code: ${code}` });
        }
      });
    });
  } catch (error) {
    sendLog(`Conda dependency installation failed: ${error.message}`, "error");
    return { success: false, error: error.message };
  }
});
// IPC handler - start backend service
function probePythonCudaCompatibility(pythonPath, runtimeEnv = process.env) {
  const probeScript = `
import json

result = {
    "success": True,
    "cuda_available": False,
    "cuda_device_count": 0,
    "cuda_compatible": None,
    "torch_version": None,
    "cuda_version": None,
    "device_name": None,
    "device_capability": None,
    "supported_arches": [],
    "message": None,
}

try:
    import torch
    result["torch_version"] = getattr(torch, "__version__", None)
    result["cuda_version"] = getattr(torch.version, "cuda", None)
    result["cuda_available"] = bool(torch.cuda.is_available())
    result["cuda_device_count"] = int(torch.cuda.device_count())

    supported_arches = []
    if hasattr(torch.cuda, "get_arch_list"):
        try:
            supported_arches = list(torch.cuda.get_arch_list() or [])
        except Exception:
            supported_arches = []
    result["supported_arches"] = supported_arches

    if result["cuda_available"] and result["cuda_device_count"] > 0:
        current_device = torch.cuda.current_device()
        capability = tuple(int(v) for v in torch.cuda.get_device_capability(current_device))
        result["device_name"] = torch.cuda.get_device_name(current_device)
        result["device_capability"] = list(capability)

        supported_arch_values = []
        for arch in supported_arches:
            if isinstance(arch, str) and arch.startswith("sm_"):
                suffix = arch[3:]
                if suffix.isdigit():
                    supported_arch_values.append(int(suffix))

        if supported_arch_values:
            device_arch = capability[0] * 10 + capability[1]
            max_supported_arch = max(supported_arch_values)
            result["cuda_compatible"] = device_arch <= max_supported_arch
            if not result["cuda_compatible"]:
                result["message"] = (
                    f"Detected GPU architecture sm_{device_arch}, but the current PyTorch build "
                    f"only supports up to sm_{max_supported_arch}. "
                    "Please use a runtime that supports CUDA 12.8/13.0 or switch to CPU mode."
                )
        else:
            result["cuda_compatible"] = True
    else:
        result["cuda_compatible"] = False
        result["message"] = "No CUDA device is available in the current runtime."
except Exception as error:
    result["success"] = False
    result["cuda_compatible"] = False
    result["message"] = str(error)

print(json.dumps(result))
`;

  try {
    const probeResult = spawnSync(pythonPath, ["-c", probeScript], {
      env: runtimeEnv,
      encoding: "utf8",
      windowsHide: true,
    });

    if (probeResult.error) {
      return {
        success: false,
        message: probeResult.error.message,
      };
    }

    const stdout = String(probeResult.stdout || "").trim();
    if (!stdout) {
      return {
        success: false,
        message: String(probeResult.stderr || "CUDA probe returned no output").trim(),
      };
    }

    return JSON.parse(stdout);
  } catch (error) {
    return {
      success: false,
      message: error.message,
    };
  }
}

ipcMain.handle("start-backend-service", async (event, config) => {
  try {
    if (backendProcess) {
      return {
        success: false,
        error: "Service is already running.",
      };
    }

    if (!global.projectPath) {
      return { success: false, error: "Project path is not set." };
    }

    const integrityResult = await ensurePackagedBackendIntegrity(global.projectPath);
    if (!integrityResult.success) {
      return {
        success: false,
        error: integrityResult.error || "Packaged backend integrity verification failed.",
      };
    }

    const projectResult = await resolveValidatedProjectPath(global.projectPath);
    if (!projectResult.success) {
      return projectResult;
    }

    global.projectPath = projectResult.path;
    let backendPython = "";
    let backendEnv = { ...process.env };
    const args = [
      "main.py",
      "start",
      `--model=${config.model}`,
      `--device=${config.device}`,
      `--port=${config.port}`,
    ];

    if (isBundledBackendMode(global.projectPath)) {
      const bundledResult = await ensureBundledRuntimeReady((message, type = "info") => {
        event.sender.send("backend-output", { message, type });
      });
      if (!bundledResult.success) {
        return bundledResult;
      }

      backendPython = bundledResult.pythonPath;
      backendEnv = getBundledRuntimeCommandEnv();
      args.push(`--model-dir=${getEffectiveBundledModelDir()}`);
    } else {
      const venvInfo = await getUsableProjectVenvInfo(global.projectPath);
      if (!venvInfo.exists || !venvInfo.valid) {
        return {
          success: false,
          error:
            venvInfo.error ||
            "Project virtual environment is missing or invalid. Create or repair .venv first.",
        };
      }

      backendPython = venvInfo.pythonPath;
      if (config.modelDir) {
        args.push(`--model-dir=${config.modelDir}`);
      }
    }

    if (config.device === "cuda") {
      const cudaProbe = probePythonCudaCompatibility(backendPython, backendEnv);
      if (!cudaProbe.success) {
        event.sender.send("backend-output", {
          type: "warning",
          message: `CUDA 预检失败，将继续尝试启动后端: ${cudaProbe.message || "未知错误"}`,
        });
      } else if (!cudaProbe.cuda_available) {
        return {
          success: false,
          error: "当前运行时未检测到可用 CUDA 设备，请切换为 CPU 模式后再启动后端。",
          cudaProbe,
        };
      } else if (cudaProbe.cuda_compatible === false) {
        const capability = Array.isArray(cudaProbe.device_capability)
          ? `sm_${cudaProbe.device_capability.join("")}`
          : "unknown";
        return {
          success: false,
          error:
            `当前运行时的 PyTorch (${cudaProbe.torch_version || "unknown"}, CUDA ${cudaProbe.cuda_version || "unknown"}) ` +
            `不支持显卡 ${cudaProbe.device_name || ""} (${capability})。` +
            "请将启动方式切换为 CPU，或升级运行时到支持 CUDA 12.8/13.0 的 PyTorch。",
          cudaProbe,
        };
      }
    }

    backendProcess = spawn(backendPython, args, {
      cwd: global.projectPath,
      stdio: "pipe",
      env: backendEnv,
    });

    backendProcess.stdout.on("data", (data) => {
      mainWindow.webContents.send("backend-output", {
        type: "info",
        message: data.toString(),
      });
    });

    backendProcess.stderr.on("data", (data) => {
      mainWindow.webContents.send("backend-output", {
        type: "info",
        message: data.toString(),
      });
    });

    backendProcess.on("close", (code, signal) => {
      const exitInfo = signal
        ? `Signal: ${signal}`
        : `Exit code: ${code !== null ? code : "Normal exit"}`;
      backendProcess = null;
      mainWindow.webContents.send("backend-output", {
        type: "info",
        message: `Service stopped, ${exitInfo}`,
      });
    });

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});

// IPC handler - stop backend service
ipcMain.handle("stop-backend-service", async () => {
  try {
    if (!backendProcess) {
      return {
        success: false,
        error: "Service is not running.",
      };
    }

    return new Promise((resolve) => {
      backendProcess.on("exit", (code, signal) => {
        const exitInfo = signal
          ? `Signal: ${signal}`
          : `Exit code: ${code !== null ? code : "Normal exit"}`;
        mainWindow.webContents.send("backend-output", {
          type: "info",
          message: `Service stopped, ${exitInfo}`,
        });
        backendProcess = null;
        resolve({ success: true });
      });

      backendProcess.kill("SIGTERM");

      setTimeout(() => {
        if (backendProcess) {
          backendProcess.kill("SIGKILL");
          mainWindow.webContents.send("backend-output", {
            type: "warning",
            message: "Service process was forcefully terminated",
          });
          backendProcess = null;
          resolve({ success: true });
        }
      }, 5000);
    });
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});
ipcMain.handle("check-backend-status", async () => {
  try {
    return {
      success: true,
      running: backendProcess !== null,
      pid: backendProcess ? backendProcess.pid : null,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});
// IPC handler - execute command
ipcMain.handle("execute-command", async (event, { command, cwd }) => {
  try {
    // Snapshot current system environment variables
    const systemEnv = { ...process.env };

    const { stdout, stderr } = await execAsync(command, {
      cwd: cwd || global.projectPath,
      env: systemEnv,
      shell: true,
    });

    return {
      success: true,
      output: stdout || stderr,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});

ipcMain.handle("show-item-in-folder", async (event, { filePath }) => {
  try {
    if (!filePath || typeof filePath !== "string") {
      return {
        success: false,
        error: "缺少有效的文件路径",
      };
    }

    const normalizedPath = path.normalize(filePath);
    const targetExists = fs.existsSync(normalizedPath);
    const targetStats = targetExists ? fs.statSync(normalizedPath) : null;
    const isDirectoryTarget = Boolean(targetStats?.isDirectory());
    const targetDirectory = isDirectoryTarget ? normalizedPath : path.dirname(normalizedPath);

    if (!fs.existsSync(targetDirectory)) {
      return {
        success: false,
        error: `目标路径不存在: ${normalizedPath}`,
      };
    }

    if (isDirectoryTarget) {
      const openError = await shell.openPath(normalizedPath);
      return {
        success: openError === "",
        error: openError || undefined,
      };
    }

    if (targetExists) {
      shell.showItemInFolder(normalizedPath);
      return {
        success: true,
      };
    }

    const openError = await shell.openPath(targetDirectory);
    return {
      success: openError === "",
      error: openError || undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});

// IPC handler - get file stats
ipcMain.handle("get-file-stats", async (event, filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: `File does not exist: ${filePath}` };
    }

    const stats = fs.statSync(filePath);
    return {
      success: true,
      data: {
        size: stats.size,
        name: path.basename(filePath),
        lastModified: stats.mtime.getTime(),
        type: getMimeType(filePath),
      },
    };
  } catch (error) {
    console.error("Failed to get file stats:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("get-video-processing-registry-path", async () => {
  try {
    const registryPath = getVideoProcessingRegistryPath();
    ensureParentDirectory(registryPath);
    return {
      success: true,
      data: {
        registryPath,
      },
    };
  } catch (error) {
    console.error("Failed to get video processing registry path:", error);
    return {
      success: false,
      error: error.message,
    };
  }
});

ipcMain.handle("compute-video-file-fingerprint", async (event, filePath) => {
  try {
    const fingerprintInfo = createQuickFileFingerprint(filePath);
    return {
      success: true,
      data: fingerprintInfo,
    };
  } catch (error) {
    console.error("Failed to compute video file fingerprint:", error);
    return {
      success: false,
      error: error.message,
    };
  }
});

// IPC handler - read file with progress
ipcMain.handle("read-file-with-progress", async (event, filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: `File does not exist: ${filePath}` };
    }

    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    const chunkSize = Math.max(1024 * 64, Math.floor(fileSize / 100)); // At least 64KB, at most 100 progress updates
    return new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath, {
        highWaterMark: chunkSize,
      });
      const chunks = [];
      let bytesRead = 0;

      stream.on("data", (chunk) => {
        chunks.push(chunk);
        bytesRead += chunk.length;

        const progress = Math.round((bytesRead / fileSize) * 100);
        event.sender.send("file-read-progress", {
          filePath,
          bytesRead,
          totalSize: fileSize,
          progress,
        });
      });

      stream.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          success: true,
          data: {
            name: path.basename(filePath),
            size: fileSize,
            type: getMimeType(filePath),
            lastModified: stats.mtime.getTime(),
            buffer: Array.from(buffer),
            path: filePath,
          },
        });
      });

      stream.on("error", (error) => {
        console.error("Failed to read file:", error);
        reject({ success: false, error: error.message });
      });
    });
  } catch (error) {
    console.error("Failed to read file:", error);
    return { success: false, error: error.message };
  }
});
// IPC handler - save temporary video file
ipcMain.handle("save-temp-video", async (event, { fileName, buffer }) => {
  try {
    const tempDir = path.join(app.getPath("temp"), "moonshine-videos");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const tempPath = path.join(tempDir, `${Date.now()}_${fileName}`);
    fs.writeFileSync(tempPath, Buffer.from(buffer));

    return tempPath;
  } catch (error) {
    console.error("Failed to save temporary video file:", error);
    throw error;
  }
});

// IPC handler - cleanup temporary file
ipcMain.handle("cleanup-temp-file", async (event, filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error("Failed to clean up temporary file:", error);
  }
});
// IPC handler - cleanup temporary files
ipcMain.handle("cleanup-temp-files", async (event, tempDir) => {
  try {
    if (fs.existsSync(tempDir)) {
      const files = fs.readdirSync(tempDir);
      for (const file of files) {
        const filePath = path.join(tempDir, file);
        fs.unlinkSync(filePath);
      }
      fs.rmdirSync(tempDir);
    }
  } catch (error) {
    console.error("Failed to clean up temporary files:", error);
  }
});
ipcMain.handle("cleanup-video-processing-temp", async (event, options = {}) => {
  try {
    const preserveTaskIds = new Set(
      Array.isArray(options?.preserveTaskIds)
        ? options.preserveTaskIds.filter((taskId) => typeof taskId === "string" && taskId.trim())
        : []
    );
    const registry = readVideoProcessingRegistry();
    const tasks = Object.entries(registry.tasks || {});
    const latestFailedTaskIds = new Set();
    const latestFailedTaskByFingerprint = new Map();

    tasks.forEach(([taskId, task]) => {
      const status = String(task?.status || "");
      const fingerprint = String(task?.fingerprint || "").trim();
      if (!fingerprint || !["failed", "running"].includes(status)) {
        return;
      }

      const previous = latestFailedTaskByFingerprint.get(fingerprint);
      if (!previous || getVideoTaskTimestamp(task) >= getVideoTaskTimestamp(previous.task)) {
        latestFailedTaskByFingerprint.set(fingerprint, { taskId, task });
      }
    });

    latestFailedTaskByFingerprint.forEach(({ taskId }) => {
      latestFailedTaskIds.add(taskId);
    });

    const nextTasks = {};
    let removedTaskCount = 0;
    let removedDirectoryCount = 0;
    let removedTempSourceCount = 0;
    let missingTaskCount = 0;

    tasks.forEach(([taskId, task]) => {
      const preserveTask = preserveTaskIds.has(taskId) || latestFailedTaskIds.has(taskId);
      const taskRoot = typeof task?.taskRoot === "string" ? task.taskRoot : "";
      const temporarySourcePath =
        typeof task?.temporarySourcePath === "string" ? task.temporarySourcePath : "";
      const hasTaskRoot = Boolean(taskRoot) && fs.existsSync(taskRoot);
      const hasTemporarySource = Boolean(temporarySourcePath) && fs.existsSync(temporarySourcePath);

      if (preserveTask) {
        if (hasTaskRoot || hasTemporarySource) {
          nextTasks[taskId] = task;
        } else {
          missingTaskCount += 1;
        }
        return;
      }

      if (hasTaskRoot) {
        fs.rmSync(taskRoot, { recursive: true, force: true });
        removedDirectoryCount += 1;
      }

      if (hasTemporarySource) {
        fs.rmSync(temporarySourcePath, { force: true });
        removedTempSourceCount += 1;
      }

      if (hasTaskRoot || hasTemporarySource) {
        removedTaskCount += 1;
      } else {
        missingTaskCount += 1;
      }
    });

    writeVideoProcessingRegistry({
      ...registry,
      tasks: nextTasks,
    });

    return {
      success: true,
      data: {
        removedTaskCount,
        removedDirectoryCount,
        removedTempSourceCount,
        preservedTaskCount: Object.keys(nextTasks).length,
        missingTaskCount,
      },
    };
  } catch (error) {
    console.error("Failed to clean up video processing temp directories:", error);
    return {
      success: false,
      error: error.message,
    };
  }
});
ipcMain.handle("remove-directory-recursive", async (event, dirPath) => {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
    return { success: true };
  } catch (error) {
    console.error("Failed to remove directory recursively:", error);
    return { success: false, error: error.message };
  }
});
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".avi": "video/avi",
    ".mov": "video/quicktime",
    ".wmv": "video/x-ms-wmv",
    ".flv": "video/x-flv",
    ".mkv": "video/x-matroska",
  };
  return mimeTypes[ext] || "application/octet-stream";
}

// needed in case process is undefined under Linux
const platform = process.platform || os.platform();
const currentDir = fileURLToPath(new URL(".", import.meta.url));

let mainWindow;

async function createWindow() {
  /**
   * Initial window options
   */
  mainWindow = new BrowserWindow({
    icon: path.resolve(currentDir, "icons/icon.png"), // tray icon
    width: 1080,
    height: 720,
    minWidth: 720,
    minHeight: 600,
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      // More info: https://v2.quasar.dev/quasar-cli-vite/developing-electron-apps/electron-preload-script
      preload: path.resolve(
        currentDir,
        path.join(
          process.env.QUASAR_ELECTRON_PRELOAD_FOLDER,
          "electron-preload" + process.env.QUASAR_ELECTRON_PRELOAD_EXTENSION
        )
      ),
    },
  });
  // Build application menu based on environment
  if (process.env.DEV) {
    // Keep the default menu in development
    const template = [
      {
        label: "File",
        submenu: [
          {
            label: "Reload",
            accelerator: "CmdOrCtrl+R",
            click: () => mainWindow.reload(),
          },
          {
            label: "Force Reload",
            accelerator: "CmdOrCtrl+Shift+R",
            click: () => mainWindow.webContents.reloadIgnoringCache(),
          },
          {
            label: "Developer Tools",
            accelerator: "F12",
            click: () => mainWindow.webContents.toggleDevTools(),
          },
          { type: "separator" },
          {
            label: "Exit",
            accelerator: process.platform === "darwin" ? "Cmd+Q" : "Ctrl+Q",
            click: () => app.quit(),
          },
        ],
      },
      {
        label: "Config",
        submenu: [
          {
            label: "Reset Config",
            click: () => {
              createDefaultConfig();
              mainWindow.webContents.send("config-reset");
            },
          },
          {
            label: "Clear State",
            click: async () => {
              clearAppStateFile();
              mainWindow.webContents.send("state-cleared");
            },
          },
        ],
      },
    ];
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  } else {
    // Remove the menu bar in production
    Menu.setApplicationMenu(null);
  }

  // Set application name
  app.setName("Moonshine-Image");

  // Set Content Security Policy
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self' data:; " +
            "script-src 'self' 'unsafe-inline'; " +
            "style-src 'self' 'unsafe-inline'; " +
            "worker-src 'self' blob:; " +
            "img-src 'self' data: blob: atom:; " +
            "media-src 'self' data: blob: atom:; " +
            "font-src 'self'; " +
            "connect-src 'self' http://localhost:* http://127.0.0.1:* data: atom:; " +
            "object-src 'none';",
        ],
      },
    });
  });
  if (process.env.DEV) {
    await mainWindow.loadURL(process.env.APP_URL);
  } else {
    await mainWindow.loadFile("index.html");
  }

  if (process.env.DEBUGGING) {
    // if on DEV or Production with debug enabled
    mainWindow.webContents.openDevTools();
  } else {
    // we're on production; no access to devtools pls
    mainWindow.webContents.on("devtools-opened", () => {
      mainWindow.webContents.closeDevTools();
    });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

const resolveAtomRequestPath = (requestUrl = "") => {
  let rawPath = String(requestUrl || "").replace(/^atom:\/\//i, "");
  rawPath = decodeURIComponent(rawPath);

  if (
    process.platform === "win32" &&
    /^[A-Za-z]\//.test(rawPath) &&
    !rawPath.includes(":")
  ) {
    rawPath = rawPath.charAt(0) + ":" + rawPath.slice(1);
  }

  return path.normalize(rawPath);
};

const registerAtomProtocol = () => {
  protocol.handle("atom", async (request) => {
    try {
      const filePath = resolveAtomRequestPath(request.url);
      if (!filePath || !fs.existsSync(filePath)) {
        console.error("File does not exist:", filePath);
        return new Response("File not found", { status: 404 });
      }

      const stats = fs.statSync(filePath);
      if (!stats.isFile()) {
        return new Response("Unsupported atom resource", { status: 400 });
      }

      return net.fetch(pathToFileURL(filePath).toString());
    } catch (error) {
      console.error("Protocol handler error:", error);
      return new Response(String(error?.message || error || "Protocol error"), {
        status: 500,
      });
    }
  });
};

app.whenReady().then(async () => {
  const integrityResult = await verifyPackagedResourcesIntegrity();
  if (!integrityResult.success) {
    dialog.showErrorBox(
      "应用资源完整性校验失败",
      `${integrityResult.error}\n\n应用将退出，请重新安装或恢复受保护资源。`
    );
    app.exit(173);
    return;
  }

  registerAtomProtocol();
  loadAppConfig();
  createWindow();
});
app.on("before-quit", async (event) => {
  if (backendProcess && !backendProcess.killed) {
    event.preventDefault();
    try {
      if (backendProcess.pid) {
        if (process.platform === "win32") {
          // Windows uses taskkill
          spawn("taskkill", ["/pid", backendProcess.pid, "/f", "/t"]);
        } else {
          // Unix-like platforms use SIGTERM
          backendProcess.kill("SIGTERM");
        }

        const exitPromise = new Promise((resolve) => {
          if (backendProcess) {
            backendProcess.on("exit", () => {
              console.log("Backend process exited");
              resolve();
            });
            backendProcess.on("error", (error) => {
              console.log("Error while waiting for backend process to exit:", error.message);
              resolve();
            });
          } else {
            resolve();
          }
        });

        const timeoutPromise = new Promise((resolve) => {
          setTimeout(() => {
            console.log("Timed out while waiting for backend process to exit");
            resolve();
          }, 5000);
        });

        await Promise.race([exitPromise, timeoutPromise]);

        if (backendProcess && !backendProcess.killed && backendProcess.pid) {
          console.log("Forcefully terminating backend process");
          if (process.platform === "win32") {
            spawn("taskkill", ["/pid", backendProcess.pid, "/f", "/t"]);
          } else {
            backendProcess.kill("SIGKILL");
          }
        }
      }

      backendProcess = null;
    } catch (error) {
      console.error("Failed to stop backend service during app shutdown:", error);
      // Clear the stale process reference even if shutdown throws
      backendProcess = null;
    }

    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (backendProcess && !backendProcess.killed) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", backendProcess.pid, "/f", "/t"]);
      } else {
        backendProcess.kill("SIGKILL");
      }
    } catch (error) {
      console.error("Failed to clean up backend process:", error);
    }
    backendProcess = null;
  }

  if (platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});
