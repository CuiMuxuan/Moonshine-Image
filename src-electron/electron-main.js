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
import nodeNet from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import crypto from "node:crypto";
import fs from "fs";
import { spawn, exec } from "child_process";
import { TextDecoder, promisify } from "util";
import {
  INTEGRITY_MANIFEST_FILE,
  INTEGRITY_PUBLIC_KEY_PEM,
  INTEGRITY_RESOURCE_DIR,
  INTEGRITY_SIGNATURE_FILE,
  PACKAGED_BACKEND_PROJECT_DIR,
  PACKAGED_BACKEND_RESOURCE_DIR,
  PACKAGED_DEFAULT_MODEL_FILE,
  PACKAGED_FFMPEG_RESOURCE_DIR,
  PACKAGED_FFMPEG_TARGET_DIR,
  PACKAGED_MODELS_RESOURCE_DIR,
  PACKAGED_RUNTIME_ENV_DIR,
  PACKAGED_RUNTIME_METADATA_FILE,
  PACKAGED_RUNTIME_RESOURCE_DIR,
  PACKAGED_RUNTIME_TARGET_DIR,
} from "./integrity/public-key.js";
import {
  alignConfigWithDefaultSchema,
  cloneConfig,
  CONFIG_SCHEMA_VERSION,
  createDefaultAppConfig,
  DEFAULT_APP_CONFIG,
  DEFAULT_IMAGE_OUTPUT_QUALITY,
  DEFAULT_MASKING_CONFIG,
  DEFAULT_TEMP_CLEANUP,
  IMAGE_PROCESSING_METHOD_OPTIONS,
  IMAGE_OUTPUT_FORMAT_OPTIONS,
  IMAGE_OUTPUT_NAMING_MODES,
  VIDEO_ENCODING_QUALITY_PRESET_OPTIONS,
  VIDEO_INPAINT_COLOR_STABILIZATION_OPTIONS,
  VIDEO_INTERMEDIATE_FRAME_STRATEGY_OPTIONS,
  VIDEO_PROCESSING_ENGINE_OPTIONS,
  isPlainObject,
  migrateLegacyConfigShape,
  needsConfigMigration,
} from "../src/shared/appConfigSchema.js";
import {
  normalizeShortcutConfig,
  validateShortcutConfig as validateShortcutConfigShape,
} from "../src/utils/shortcutConfig.js";
import { createDefaultSam3Lexicon } from "../src/shared/samLexiconDefaults.js";
import {
  bootstrapApplication,
  ApplicationBootstrapError,
  createFatalStartupHandler,
} from "./app-bootstrap.js";
import { BackendProcessSupervisor } from "./backend-process-supervisor.js";
import {
  createDiagnostic,
  createStartupLogger,
  toStartupFailure,
} from "./startup-diagnostics.js";
import { runStartupProcess } from "./startup-process.js";
import { downloadHttpsFile } from "./startup-download.js";
import { runStartupIpcOperation } from "./startup-ipc.js";
import { StartupOperationRegistry } from "./startup-operation-registry.js";
import {
  buildImportProbeScript,
  createImportProbeArgs,
  createIsolatedPythonEnv,
  detectSupportedPython,
  isSupportedPythonVersion,
  parseImportProbeResult,
} from "./python-runtime.js";
const execAsync = promisify(exec);
const APP_DISPLAY_NAME = "Moonshine-Image";
const LEGACY_APP_NAME = "moonshine-client";

app.setName(APP_DISPLAY_NAME);
app.setPath("userData", path.join(app.getPath("appData"), APP_DISPLAY_NAME));
const STARTUP_LOG_PATH = path.join(app.getPath("userData"), "logs", "startup.log");
const startupLogger = createStartupLogger({ logPath: STARTUP_LOG_PATH });

function toLoggedStartupFailure(error, options = {}) {
  const failure = toStartupFailure(error, {
    ...options,
    logPath: STARTUP_LOG_PATH,
    diagnostic: {
      ...(options.diagnostic || {}),
      logPath: STARTUP_LOG_PATH,
    },
  });
  void startupLogger.error(failure.error, {
    code: failure.code,
    recoveryHint: failure.recoveryHint,
    diagnostic: failure.diagnostic,
  });
  return failure;
}

function augmentStartupFailure(result = {}, options = {}) {
  if (result.success === false && result.code && result.recoveryHint && result.diagnostic?.id) {
    return result;
  }
  const sourceError = new Error(result.error || options.userMessage || "Startup failed.");
  const failure = toLoggedStartupFailure(sourceError, {
    ...options,
    code: result.code || options.code,
    userMessage: result.error || options.userMessage,
    recoveryHint: result.recoveryHint || options.recoveryHint,
    diagnostic: result.diagnostic,
    attempts: result.attempts,
  });
  return { ...result, ...failure };
}

function createSupervisorFailure(input = {}) {
  const cause = input.cause || new Error(input.reason || input.error || input.code);
  return toLoggedStartupFailure(cause, {
    code: input.code,
    stage: input.stage,
    reason: input.reason,
    userMessage: input.error,
    recoveryHint: input.recoveryHint,
    commandLine: input.commandLine,
    cwd: input.cwd,
    osCode: input.osCode,
    exitCode: input.exitCode,
    signal: input.signal,
    timedOut: input.timedOut,
    durationMs: input.durationMs,
    stdout: input.stdoutTail,
    stderr: input.stderrTail,
    attempts: input.attempts,
  });
}

let mainWindow = null;
let allowCloseWithActiveProcessingTasks = false;
let sessionSecurityRegistered = false;
let rendererFailureDialogOpen = false;
let quitAfterBackendStop = false;
let backendShutdownPromise = null;
let backendLaunchPromise = null;
let backendLaunchAbortController = null;
let backendStopPromise = null;
let applicationQuitRequested = false;
let applicationBootstrapPromise = null;
let applicationBootstrapComplete = false;
const ACTIVE_STARTUP_SETTLEMENT_TIMEOUT_MS = 10000;
const startupOperationRegistry = new StartupOperationRegistry({
  getInitialAbortReason: () =>
    applicationQuitRequested
      ? new Error("Application quit cancelled startup operations.")
      : null,
});

async function withTrackedStartupOperation(operation, externalSignal) {
  return await startupOperationRegistry.run(operation, externalSignal);
}

function abortActiveStartupOperations(reason) {
  return startupOperationRegistry.abort(reason);
}

async function waitForActiveStartupOperations(
  timeoutMs = ACTIVE_STARTUP_SETTLEMENT_TIMEOUT_MS
) {
  return await startupOperationRegistry.waitForSettled(timeoutMs);
}

function sendToMainWindow(channel, payload) {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    !mainWindow.webContents ||
    mainWindow.webContents.isDestroyed()
  ) {
    return false;
  }
  mainWindow.webContents.send(channel, payload);
  return true;
}

function createBackendOutputPayload(message, type = "info", metadata = {}) {
  const timestamp = metadata.timestamp || new Date().toISOString();
  return {
    ...metadata,
    message: String(message ?? ""),
    type,
    stream: metadata.stream || "lifecycle",
    stage: metadata.stage || "startup",
    diagnosticId: metadata.diagnosticId || metadata.diagnostic?.id || null,
    timestamp,
  };
}

function sendBackendOutput(message, type = "info", metadata = {}, target = null) {
  const payload = createBackendOutputPayload(message, type, metadata);
  const webContents = target || mainWindow?.webContents;
  if (webContents && !webContents.isDestroyed?.()) {
    webContents.send("backend-output", payload);
  }
  return payload;
}

function createBackendOutputSender(target, stage) {
  return (message, type = "info", metadata = {}) =>
    sendBackendOutput(message, type, { stage, ...metadata }, target);
}

async function probeBackendHealth(port, options = {}) {
  const signal = options.signal;
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    controller.abort(signal.reason);
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(new Error("Health probe timed out.")), 1500);
  timeout.unref?.();

  try {
    const response = await net.fetch(
      `http://${BACKEND_PORT_HOST}:${port}/api/v1/health?_=${Date.now()}`,
      {
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Pragma: "no-cache",
        },
        signal: controller.signal,
      }
    );
    if (!response.ok) return false;
    const body = await response.json();
    return body?.status === "ok";
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function terminateBackendProcessTree(child, options = {}) {
  const { force = false, record, signal } = options;
  if (!child?.pid || record?.closed) return;

  if (process.platform === "win32") {
    try {
      await runStartupProcess(
        "taskkill",
        ["/pid", String(child.pid), "/t", ...(force ? ["/f"] : [])],
        {
          timeoutMs: 5000,
          stage: force ? "backend-force-stop" : "backend-stop",
          failureCode: "BACKEND_PROCESS_TERMINATION_FAILED",
          userMessage: "Failed to terminate the backend process tree.",
          recoveryHint: "Close the application and terminate the recorded process manually.",
          logPath: STARTUP_LOG_PATH,
          signal,
        }
      );
    } catch (error) {
      if (record?.closed || child.exitCode !== null) return;
      throw error;
    }
    return;
  }

  const killSignal = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-child.pid, killSignal);
  } catch (error) {
    if (error?.code === "ESRCH" || record?.closed || child.exitCode !== null) return;
    child.kill(killSignal);
  }
}

const backendSupervisor = new BackendProcessSupervisor({
  spawnImpl: spawn,
  probeReady: probeBackendHealth,
  terminateProcess: terminateBackendProcessTree,
  createFailure: createSupervisorFailure,
  decodeOutput: decodeProcessOutput,
  readinessTimeoutMs: 120000,
  pollIntervalMs: 500,
  onOutput: (payload) => {
    const output = createBackendOutputPayload(payload.message, payload.type, payload);
    sendToMainWindow("backend-output", output);
    const logMethod = output.type === "error" ? "error" : output.type === "warning" ? "warning" : "info";
    void startupLogger[logMethod](output.message, output);
  },
  onState: (payload) => {
    sendToMainWindow("backend-service-state", payload);
    void startupLogger.info(`Backend service state changed to ${payload.state}.`, payload);
  },
});

function createBackendStartCancellation(reason = "Backend startup was cancelled.") {
  const failure = toStartupFailure(new Error(reason), {
    code: "BACKEND_START_CANCELLED",
    stage: "backend-preflight",
    userMessage: "Backend startup was cancelled.",
    recoveryHint: "No action is required.",
    logPath: STARTUP_LOG_PATH,
  });
  return {
    ...failure,
    cancelled: true,
    expected: true,
  };
}

function getBackendStartCancellation(signal) {
  if (!signal?.aborted && !applicationQuitRequested) return null;
  return createBackendStartCancellation(
    signal?.reason?.message ||
      (applicationQuitRequested
        ? "Application quit while backend startup was in progress."
        : "Backend startup was cancelled.")
  );
}

async function stopBackendServiceAndPendingLaunch(reason) {
  abortActiveStartupOperations(reason || "Backend stop was requested.");
  const activeLaunch = backendLaunchPromise;
  if (backendLaunchAbortController && !backendLaunchAbortController.signal.aborted) {
    backendLaunchAbortController.abort(new Error(reason || "Backend startup was cancelled."));
  }

  let stopResult = await backendSupervisor.stop();
  if (activeLaunch) {
    try {
      await activeLaunch;
    } catch (error) {
      void startupLogger.error("Pending backend startup rejected during cancellation.", {
        reason: error?.message || String(error),
      });
    }
  }
  const operationSettlement = await waitForActiveStartupOperations();
  if (!operationSettlement.settled) {
    void startupLogger.warning("Startup operations did not settle before the shutdown deadline.", {
      stage: "startup-operation-shutdown",
      pending: operationSettlement.pending,
      timeoutMs: ACTIVE_STARTUP_SETTLEMENT_TIMEOUT_MS,
    });
  }
  if (backendSupervisor.getStatus().processRunning) {
    const finalStopResult = await backendSupervisor.stop();
    if (!finalStopResult.success) stopResult = finalStopResult;
  }
  return {
    ...stopResult,
    startupOperationsSettled: operationSettlement.settled,
    pendingStartupOperations: operationSettlement.pending,
  };
}

// Backend service state
global.projectPath = "";
const activeFfmpegTasks = new Map();
const activeProcessingTasks = new Map();

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
// Global configuration object
let globalConfig = cloneConfig(DEFAULT_APP_CONFIG);

const TARGET_PYTHON_VERSION = "3.12.11";
const BUNDLED_RUNTIME_STATE_FILE = "runtime-state.json";
const BUNDLED_RUNTIME_LOCK_FILE = ".prepare.lock";
const BUNDLED_RUNTIME_LOCK_WAIT_MS = 300000;
const BUNDLED_RUNTIME_LOCK_STALE_MS = 120000;
const VIDEO_PROCESSING_REGISTRY_FILE = "moonshine_video_resume_index.json";
const QUICK_FINGERPRINT_SAMPLE_SIZE = 64 * 1024;
const BACKEND_PATH_CJK_BLOCK_MESSAGE =
  "项目路径中存在中文，可能导致项目运行失败，本次静默启动停止，请在全局配置后端配置中记录当前的项目路径和模型路径，然后将其移动到不含中文的路径下，并选择该路径。";
const CJK_PATH_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const BACKEND_PORT_HOST = "127.0.0.1";
const BACKEND_PORT_RETRY_LIMIT = 20;
const DEFAULT_DISK_SPACE_SAFETY_BYTES = 64 * 1024 * 1024;
const COMPLETE_PROCESS_ENV = Symbol("moonshine-complete-process-env");
let packagedIntegrityStatus = null;

function validateShortcutConfig(shortcuts = {}) {
  return validateShortcutConfigShape(shortcuts).length === 0;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeInteger(value, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return clampNumber(Math.round(numeric), min, max);
}

const DEFAULT_BACKEND_MODEL_IDS = Object.freeze(["lama", "mat"]);
function normalizeDefaultBackendModel(value, launchMode = "cuda") {
  const normalized = String(value || "").trim().toLowerCase();
  const model = DEFAULT_BACKEND_MODEL_IDS.includes(normalized) ? normalized : "lama";
  return model === "mat" && launchMode !== "cuda" ? "lama" : model;
}

function mergeConfigForStrictValidation(config = {}) {
  const merged = mergeConfigWithDefaults(config);
  if (isPlainObject(config?.advanced)) {
    merged.advanced = {
      ...merged.advanced,
      ...config.advanced,
    };
  }
  if (isPlainObject(config?.video)) {
    merged.video = {
      ...merged.video,
      ...config.video,
    };
  }
  if (isPlainObject(config?.general)) {
    merged.general = {
      ...merged.general,
      ...config.general,
    };
  }
  if (isPlainObject(config?.fileManagement)) {
    merged.fileManagement = {
      ...merged.fileManagement,
      ...config.fileManagement,
    };
  }
  if (isPlainObject(config?.masking)) {
    merged.masking = {
      ...merged.masking,
      ...config.masking,
    };
  }
  return merged;
}

function normalizeBoolean(value, fallback = true) {
  return typeof value === "boolean" ? value : fallback;
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

function getPackagedFfmpegResourceRootPath() {
  return path.join(
    getResourcesRootPath(),
    PACKAGED_FFMPEG_RESOURCE_DIR,
    PACKAGED_FFMPEG_TARGET_DIR
  );
}

function getDefaultModelDir() {
  return app.isPackaged
    ? getPackagedModelsPath()
    : path.join(process.cwd(), PACKAGED_MODELS_RESOURCE_DIR);
}

function isLegacyDefaultModelDir(modelDir) {
  const normalized = path.normalize(String(modelDir || ""));
  if (!normalized) {
    return true;
  }

  return (
    normalized === path.normalize(path.join(os.homedir(), ".cache", "torch", "hub", "checkpoints"))
  );
}

function getBundledDefaultModelPath() {
  return path.join(getPackagedModelsPath(), PACKAGED_DEFAULT_MODEL_FILE);
}

function getBundledRuntimeRootPath() {
  return path.join(app.getPath("userData"), "runtime");
}

function getLegacyUserDataPath() {
  return path.join(app.getPath("appData"), LEGACY_APP_NAME);
}

function getLegacyRuntimeBackendPath() {
  return path.join(getLegacyUserDataPath(), "runtime", "backend");
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

function normalizeByteCount(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }
  return Math.ceil(numeric);
}

function formatBytes(value) {
  let size = normalizeByteCount(value);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return index === 0 ? `${Math.round(size)} ${units[index]}` : `${size.toFixed(1)} ${units[index]}`;
}

function resolveDiskSpaceCheckPath(targetPath) {
  const rawPath = String(targetPath || "").trim() || app.getPath("userData");
  const normalizedPath = path.resolve(path.normalize(rawPath));
  const hasExtension = Boolean(path.extname(normalizedPath));
  const directory = hasExtension ? path.dirname(normalizedPath) : normalizedPath;
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return directory;
}

function getAvailableDiskSpace(targetPath) {
  const checkPath = resolveDiskSpaceCheckPath(targetPath);
  if (typeof fs.statfsSync !== "function") {
    return {
      success: false,
      path: checkPath,
      error: "当前运行时不支持磁盘空间检测。",
    };
  }
  const stats = fs.statfsSync(checkPath, { bigint: false });
  const blockSize = normalizeByteCount(stats.bsize || stats.frsize || 0, 0);
  const availableBlocks = normalizeByteCount(stats.bavail || stats.bfree || 0, 0);
  return {
    success: true,
    path: checkPath,
    freeBytes: blockSize * availableBlocks,
  };
}

function ensureDiskSpace(targetPath, payload = {}) {
  const requiredBytes = normalizeByteCount(payload.requiredBytes ?? payload.bytes ?? 0);
  const safetyBytes = normalizeByteCount(
    payload.safetyBytes,
    DEFAULT_DISK_SPACE_SAFETY_BYTES
  );
  const operation = String(payload.operation || "写入文件");
  const totalRequiredBytes = requiredBytes + safetyBytes;
  const info = getAvailableDiskSpace(targetPath);
  if (!info.success) {
    throw new Error(info.error || "磁盘空间检测失败。");
  }
  if (info.freeBytes < totalRequiredBytes) {
    throw new Error(
      `${operation}磁盘空间不足。预计至少需要 ${formatBytes(totalRequiredBytes)}，` +
        `当前可用 ${formatBytes(info.freeBytes)}。请清理磁盘空间或在全局设置中更换输出/临时目录后重试。`
    );
  }
  return {
    success: true,
    ok: true,
    path: info.path,
    freeBytes: info.freeBytes,
    requiredBytes,
    safetyBytes,
    totalRequiredBytes,
  };
}

function getBufferByteLength(value) {
  if (!value) return 0;
  if (Buffer.isBuffer(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof value === "string") return Buffer.byteLength(value);
  return 0;
}

function getFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function sumExistingFileSizes(filePaths = []) {
  return (Array.isArray(filePaths) ? filePaths : []).reduce(
    (total, filePath) => total + getFileSize(filePath),
    0
  );
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

function getLatestFailedVideoTaskIds(registry = readVideoProcessingRegistry()) {
  const latestFailedTaskByFingerprint = new Map();

  Object.entries(registry.tasks || {}).forEach(([taskId, task]) => {
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

  return new Set(Array.from(latestFailedTaskByFingerprint.values()).map(({ taskId }) => taskId));
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

function markCompleteProcessEnv(environment) {
  Object.defineProperty(environment, COMPLETE_PROCESS_ENV, {
    value: true,
    enumerable: false,
  });
  return environment;
}

function getUtf8ProcessEnv(overrides = {}) {
  const inheritProcessEnv = overrides?.[COMPLETE_PROCESS_ENV] !== true;
  const environment = {
    ...(inheritProcessEnv ? process.env : {}),
    ...(overrides || {}),
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
  return inheritProcessEnv ? environment : markCompleteProcessEnv(environment);
}

function getIsolatedPythonCommandEnv(envRoot, overrides = {}) {
  return markCompleteProcessEnv(
    createIsolatedPythonEnv({
      baseEnv: process.env,
      envRoot,
      platform: os.platform(),
      overrides,
    })
  );
}

function getCleanPythonCommandEnv(overrides = {}) {
  return markCompleteProcessEnv(
    createIsolatedPythonEnv({
      baseEnv: process.env,
      platform: os.platform(),
      overrides,
    })
  );
}

function wrapUtf8ShellCommand(command) {
  if (os.platform() !== "win32") {
    return command;
  }

  return `chcp 65001 > nul && ${command}`;
}

function decodeProcessOutput(data) {
  if (!data) {
    return "";
  }

  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  if (buffer.length === 0) {
    return "";
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    if (os.platform() === "win32") {
      try {
        return new TextDecoder("gb18030").decode(buffer);
      } catch {
        // Fall through to Node's UTF-8 decoder.
      }
    }
  }

  return buffer.toString("utf8");
}

function quoteShellArg(arg) {
  const value = String(arg);
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

function buildShellCommand(command, args = []) {
  return [command, ...args].map(quoteShellArg).join(" ");
}

function getWindowsShellInvocation(command, args = []) {
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", wrapUtf8ShellCommand(buildShellCommand(command, args))],
  };
}

async function execFileCommand(command, args = [], options = {}) {
  const env = getUtf8ProcessEnv(options.env);
  return await withTrackedStartupOperation(
    (signal) =>
      runStartupProcess(command, args, {
        cwd: options.cwd,
        env,
        windowsHide: true,
        detached: options.detached ?? os.platform() !== "win32",
        timeoutMs: options.timeout,
        signal,
        stage: options.stage || "process-exec",
        failureCode: options.failureCode,
        userMessage: options.userMessage,
        recoveryHint: options.recoveryHint,
        logPath: STARTUP_LOG_PATH,
        onStdout: options.onStdout,
        onStderr: options.onStderr,
        terminateProcess:
          options.terminateProcess ||
          ((child) => terminateBackendProcessTree(child, { force: true })),
      }),
    options.signal
  );
}

async function execCondaCommand(args = [], options = {}) {
  if (os.platform() === "win32") {
    const invocation = getWindowsShellInvocation("conda", args);
    return await execFileCommand(invocation.command, invocation.args, options);
  }
  return await execFileCommand("conda", args, options);
}

async function execCommand(command, options = {}) {
  const { env, ...execOptions } = options;
  const result = await execAsync(wrapUtf8ShellCommand(command), {
    shell: true,
    ...execOptions,
    encoding: "buffer",
    env: getUtf8ProcessEnv(env),
  });

  return {
    ...result,
    stdout: decodeProcessOutput(result.stdout),
    stderr: decodeProcessOutput(result.stderr),
  };
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
  return isSupportedPythonVersion(versionInfo);
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

function containsCjkCharacter(value) {
  return CJK_PATH_PATTERN.test(String(value || ""));
}

function normalizeBackendPathValidationInput(input = {}) {
  const backendProjectPathInput =
    input.backendProjectPath !== undefined
      ? input.backendProjectPath
      : globalConfig.general?.backendProjectPath || global.projectPath || "";
  const modelDirInput =
    input.modelDir !== undefined
      ? input.modelDir
      : globalConfig.general?.modelDir || "";

  const backendProjectPath = normalizeStoredBackendProjectPath(backendProjectPathInput);
  const modelDir = String(modelDirInput || "").trim();
  const bundledMode = isBundledBackendMode(backendProjectPath || getDefaultBackendProjectPath());
  const effectiveModelDir = modelDir || (bundledMode ? getEffectiveBundledModelDir() : "");

  return {
    backendProjectPath,
    modelDir,
    bundledMode,
    effectiveModelDir,
  };
}

function buildBackendPathValidationResult(input = {}) {
  const normalized = normalizeBackendPathValidationInput(input);
  const invalidPaths = [];

  if (normalized.backendProjectPath && containsCjkCharacter(normalized.backendProjectPath)) {
    invalidPaths.push({
      field: "backendProjectPath",
      label: "后端项目路径",
      path: normalized.backendProjectPath,
    });
  }

  if (normalized.modelDir && containsCjkCharacter(normalized.modelDir)) {
    invalidPaths.push({
      field: "modelDir",
      label: "模型目录路径",
      path: normalized.modelDir,
    });
  }

  if (normalized.bundledMode && containsCjkCharacter(normalized.effectiveModelDir)) {
    invalidPaths.push({
      field: "effectiveModelDir",
      label: "内置模型目录路径",
      path: normalized.effectiveModelDir,
    });
  }

  if (invalidPaths.length > 0) {
    return {
      success: true,
      valid: false,
      code: "BACKEND_PATH_CONTAINS_CJK",
      message: BACKEND_PATH_CJK_BLOCK_MESSAGE,
      invalidPaths,
      paths: normalized,
    };
  }

  return {
    success: true,
    valid: true,
    code: "",
    message: "",
    invalidPaths: [],
    paths: normalized,
  };
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

function isBackendPortAvailable(port, host = BACKEND_PORT_HOST) {
  return new Promise((resolve) => {
    const probe = nodeNet.createServer();

    const cleanup = () => {
      probe.removeAllListeners();
    };

    probe.once("error", () => {
      cleanup();
      resolve(false);
    });

    probe.once("listening", () => {
      probe.close(() => {
        cleanup();
        resolve(true);
      });
    });

    probe.listen(port, host);
  });
}

async function resolveAvailableBackendPort(preferredPort, options = {}) {
  const retryLimit = normalizeInteger(
    options.retryLimit,
    BACKEND_PORT_RETRY_LIMIT,
    1,
    100
  );
  const basePort = normalizeInteger(preferredPort, 8080, 1024, 65535);
  const attemptedPorts = [];

  for (let offset = 0; offset < retryLimit; offset += 1) {
    const port = basePort + offset;
    if (port > 65535) {
      break;
    }

    attemptedPorts.push(port);
    if (await isBackendPortAvailable(port)) {
      return {
        success: true,
        port,
        requestedPort: basePort,
        portChanged: port !== basePort,
        attemptedPorts,
      };
    }
  }

  return {
    success: false,
    requestedPort: basePort,
    attemptedPorts,
    error: `后端端口 ${attemptedPorts.join(", ")} 均已被占用，请释放其中一个端口或在全局设置中指定其他端口。`,
  };
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
      ensureDiskSpace(targetPath, {
        requiredBytes: Number(entry.size || getFileSize(sourcePath)),
        operation: "复制后端运行资源",
      });
      fs.copyFileSync(sourcePath, targetPath);
    }
  }

  return {
    ...integrityResult,
    runtimeProjectPath,
  };
}

function isBackendProjectStructureComplete(projectPath) {
  if (!projectPath || !fs.existsSync(projectPath)) {
    return false;
  }

  const requiredFiles = ["requirements.txt", "main.py"];
  const requiredDirs = ["moonshine_server"];
  return (
    requiredFiles.every((fileName) => fs.existsSync(path.join(projectPath, fileName))) &&
    requiredDirs.every((dirName) => {
      const dirPath = path.join(projectPath, dirName);
      return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
    })
  );
}

function getPackagedRuntimeMetadata() {
  const metadataPath = getPackagedRuntimeMetadataPath();
  if (!fs.existsSync(metadataPath)) {
    return {};
  }
  try {
    return readJsonFile(metadataPath);
  } catch (error) {
    console.warn("Failed to read packaged runtime metadata:", error);
    return {};
  }
}

function getBundledRuntimeCommandEnv(overrides = {}) {
  const modelDir = getPackagedModelsPath();
  const runtimeMetadata = getPackagedRuntimeMetadata();
  return getIsolatedPythonCommandEnv(getBundledRuntimeEnvPath(), {
    MOONSHINE_PACKAGED_RUNTIME: "1",
    MOONSHINE_RUNTIME_FLAVOR: runtimeMetadata.runtimeFlavor || "external",
    MOONSHINE_MODEL_BUNDLE: runtimeMetadata.modelBundle || "external-models",
    ...overrides,
    TORCH_HOME: modelDir,
    XDG_CACHE_HOME: modelDir,
    U2NET_HOME: modelDir,
    HF_HOME: path.join(modelDir, "huggingface"),
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    LAMA_MODEL_URL: getBundledDefaultModelPath(),
  });
}

function getEffectiveBundledModelDir() {
  return getPackagedModelsPath();
}

function resolveEffectiveModelDir(input = {}) {
  const modelDir =
    input.modelDir !== undefined ? input.modelDir : globalConfig.general?.modelDir || "";
  const configuredModelDir = String(modelDir || "").trim();
  return configuredModelDir || getEffectiveBundledModelDir();
}

async function runProcess(command, args = [], options = {}) {
  return await withTrackedStartupOperation(
    (signal) =>
      runStartupProcess(command, args, {
        cwd: options.cwd,
        env: getUtf8ProcessEnv(options.env),
        stdio: options.stdio || "pipe",
        shell: options.shell || false,
        detached: options.detached ?? os.platform() !== "win32",
        timeoutMs: options.timeout,
        signal,
        stage: options.stage || "startup-process",
        failureCode: options.failureCode,
        userMessage: options.errorMessage,
        recoveryHint: options.recoveryHint,
        logPath: STARTUP_LOG_PATH,
        onStdout: options.onStdout,
        onStderr: options.onStderr,
        terminateProcess:
          options.terminateProcess ||
          ((child) => terminateBackendProcessTree(child, { force: true })),
      }),
    options.signal
  );
}

async function runBundledCondaUnpack(sendLog, options = {}) {
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
      failureCode: "BUNDLED_RUNTIME_RELOCATION_FAILED",
      stage: "bundled-runtime-relocation",
      recoveryHint: "Re-extract the application to a writable directory and check security software.",
      signal: options.signal,
      onStdout: (text) => sendLog?.(text, "info"),
      onStderr: (text) => sendLog?.(text, "warning"),
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
        failureCode: "BUNDLED_RUNTIME_RELOCATION_FAILED",
        stage: "bundled-runtime-relocation",
        recoveryHint: "Re-extract the application to a writable directory and check security software.",
        signal: options.signal,
        onStdout: (text) => sendLog?.(text, "info"),
        onStderr: (text) => sendLog?.(text, "warning"),
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

async function withBundledRuntimeLock(task, options = {}) {
  const runtimeRoot = getBundledRuntimeRootPath();
  const lockPath = getBundledRuntimeLockPath();
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const deadline = Date.now() + BUNDLED_RUNTIME_LOCK_WAIT_MS;

  while (true) {
    if (options.signal?.aborted) {
      throw options.signal.reason || new Error("Bundled runtime preparation was cancelled.");
    }
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

function writeBundledRuntimeState(runtimeMetadata, bundledPython = getBundledPythonPath()) {
  writeJsonFile(getBundledRuntimeStatePath(), {
    schemaVersion: 2,
    preparedAt: new Date().toISOString(),
    runtimeBuiltAt: runtimeMetadata.builtAt,
    resourcesRootPath: getResourcesRootPath(),
    runtimeEnvPath: getBundledRuntimeEnvPath(),
    backendPath: getPackagedBackendRuntimeProjectPath(),
    pythonPath: bundledPython,
    defaultModelFilePath: getBundledDefaultModelPath(),
  });
}

async function verifyBundledPythonRuntime(options = {}) {
  const checkDependencies = options.checkDependencies === true;
  const bundledPython = getBundledPythonPath();
  if (!fs.existsSync(bundledPython)) {
    return {
      success: false,
      error: `Bundled Python executable is missing: ${bundledPython}`,
    };
  }

  const versionResult = await getPythonVersionFromCommand(bundledPython, [], {
    cwd: getPackagedBackendRuntimeProjectPath(),
    env: getBundledRuntimeCommandEnv(),
    signal: options.signal,
  });
  if (!versionResult.success) {
    return versionResult;
  }

  if (checkDependencies) {
    const dependencyResult = await probePythonDependencies(
      bundledPython,
      ["fastapi", "uvicorn", "numpy", "PIL", "torch", "transformers"],
      {
        cwd: getPackagedBackendRuntimeProjectPath(),
        timeout: 30000,
        env: getBundledRuntimeCommandEnv(),
        signal: options.signal,
      }
    );
    if (!dependencyResult.success) {
      return {
        success: false,
        code: dependencyResult.code || "BUNDLED_DEPENDENCIES_UNUSABLE",
        error: dependencyResult.error,
        missingModules: dependencyResult.missingModules,
        dependencyErrors: dependencyResult.errors,
        stderr: dependencyResult.stderr,
      };
    }
  }

  return {
    success: true,
    pythonPath: bundledPython,
    pythonVersion: versionResult.version?.text || "",
  };
}

async function ensureBundledRuntimeReady(sendLog, options = {}) {
  const integrityResult = await ensurePackagedBackendIntegrity(
    getPackagedBackendRuntimeProjectPath()
  );
  if (!integrityResult.success) {
    return augmentStartupFailure(integrityResult, {
      code: "PACKAGED_BACKEND_INTEGRITY_FAILED",
      stage: "bundled-runtime-integrity",
    });
  }

  if (!fs.existsSync(getPackagedRuntimeEnvPath())) {
    return augmentStartupFailure(
      {
        success: false,
        code: "BUNDLED_RUNTIME_MISSING",
        error: `Bundled runtime directory is missing: ${getPackagedRuntimeEnvPath()}`,
      },
      { stage: "bundled-runtime-validation" }
    );
  }

  if (!fs.existsSync(getPackagedRuntimeMetadataPath())) {
    return augmentStartupFailure(
      {
        success: false,
        code: "BUNDLED_RUNTIME_METADATA_MISSING",
        error: `Bundled runtime metadata is missing: ${getPackagedRuntimeMetadataPath()}`,
      },
      { stage: "bundled-runtime-validation" }
    );
  }

  const runtimeMetadata = readJsonFile(getPackagedRuntimeMetadataPath());

  await withBundledRuntimeLock(async () => {
    const state = getBundledRuntimeState();
    if (!hasBundledRuntimeStateChanged(runtimeMetadata)) {
      return;
    }

    const existingRuntime = await verifyBundledPythonRuntime({
      checkDependencies: true,
      signal: options.signal,
    });
    if (existingRuntime.success && fs.existsSync(getPackagedBackendRuntimeProjectPath())) {
      sendLog?.(
        "Bundled Python runtime is already usable. Refreshing runtime state...",
        "info"
      );
      writeBundledRuntimeState(runtimeMetadata, existingRuntime.pythonPath);
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
      await runBundledCondaUnpack(sendLog, options);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const fallbackRuntime = await verifyBundledPythonRuntime({
        checkDependencies: true,
        signal: options.signal,
      });
      const relocationFailure = toStartupFailure(error, {
        code: "BUNDLED_RUNTIME_RELOCATION_FAILED",
        stage: "bundled-runtime-relocation",
        userMessage: "Bundled Python runtime relocation failed.",
        recoveryHint:
          "Re-extract the application to a writable directory and check security software.",
        logPath: STARTUP_LOG_PATH,
      });
      if (fallbackRuntime.success) {
        sendLog?.(
          `Bundled runtime relocation reported a warning, but Python is usable: ${error.message}`,
          "warning",
          {
            diagnostic: relocationFailure.diagnostic,
            diagnosticId: relocationFailure.diagnostic.id,
            recoveryHint: relocationFailure.recoveryHint,
          }
        );
        void startupLogger.warning(relocationFailure.error, {
          recoveryHint: relocationFailure.recoveryHint,
          diagnostic: relocationFailure.diagnostic,
        });
        writeBundledRuntimeState(runtimeMetadata, fallbackRuntime.pythonPath);
        return;
      }

      const recheckFailure = toStartupFailure(
        new Error(fallbackRuntime.error || "Bundled runtime recheck failed."),
        {
          code: fallbackRuntime.code || "BUNDLED_RUNTIME_RECHECK_FAILED",
          stage: "bundled-runtime-recheck",
          userMessage: fallbackRuntime.error || "Bundled runtime recheck failed.",
          diagnostic: fallbackRuntime.diagnostic,
          logPath: STARTUP_LOG_PATH,
        }
      );
      error.diagnostic = createDiagnostic({
        ...relocationFailure.diagnostic,
        attempts: [relocationFailure.diagnostic, recheckFailure.diagnostic],
        logPath: STARTUP_LOG_PATH,
      });

      if (appMoved) {
        clearBundledRuntimeState();
        error.message = `${error.message} The app appears to have been moved after the bundled runtime was prepared. Please re-extract the packaged app to a fresh directory and try again.`;
      }
      throw error;
    }

    const preparedRuntime = await verifyBundledPythonRuntime({
      checkDependencies: true,
      signal: options.signal,
    });
    if (!preparedRuntime.success) {
      throw new Error(preparedRuntime.error || "Bundled Python runtime verification failed.");
    }

    writeBundledRuntimeState(runtimeMetadata, preparedRuntime.pythonPath);
  }, options);

  const runtimeResult = await verifyBundledPythonRuntime({
    checkDependencies: true,
    signal: options.signal,
  });
  if (!runtimeResult.success) {
    return augmentStartupFailure(runtimeResult, {
      code: runtimeResult.code || "BUNDLED_RUNTIME_UNUSABLE",
      stage: "bundled-runtime-verification",
    });
  }

  return {
    success: true,
    path: getPackagedBackendRuntimeProjectPath(),
    pythonPath: runtimeResult.pythonPath,
    pythonVersion: runtimeResult.pythonVersion,
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

function formatCommandLabel(command, args = []) {
  return [command, ...args].join(" ");
}

async function getPythonVersionFromCommand(pythonCommand, args = [], options = {}) {
  try {
    const { stdout, stderr } = await execFileCommand(pythonCommand, [...args, "--version"], {
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
      code: error.startupCode || error.code || "PYTHON_VERSION_CHECK_FAILED",
      error: error.userMessage || error.message || "Python version check command failed.",
      osCode: error.osCode,
      diagnostic: error.diagnostic,
    };
  }
}

async function probePythonDependencies(pythonCommand, modules, options = {}) {
  const args = createImportProbeArgs(modules);
  let processResult;
  let failureMetadata = {};
  try {
    const { stdout, stderr } = await execFileCommand(pythonCommand, args, options);
    processResult = { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const diagnostic = error?.diagnostic;
    processResult = {
      stdout: diagnostic?.stdoutTail || decodeProcessOutput(error?.stdout),
      stderr: diagnostic?.stderrTail || decodeProcessOutput(error?.stderr),
      exitCode: diagnostic?.exitCode ?? error?.exitCode ?? null,
    };
    failureMetadata = {
      diagnostic,
      attempts: diagnostic?.attempts || error?.attempts,
    };
  }
  return { ...parseImportProbeResult(processResult), ...failureMetadata };
}

async function detectSystemPython() {
  const commandCandidates =
    os.platform() === "win32"
      ? [
          { command: "py", args: ["-3.12"] },
          { command: "py", args: ["-3.11"] },
          { command: "py", args: ["-3.10"] },
          { command: "python", args: [] },
          { command: "py", args: ["-3"] },
          { command: "py", args: [] },
          { command: "python3", args: [] },
        ]
      : [
          { command: "python3.12", args: [] },
          { command: "python3.11", args: [] },
          { command: "python3.10", args: [] },
          { command: "python3", args: [] },
          { command: "python", args: [] },
        ];

  if (os.platform() === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const pathCandidates = [
      "C:\\Python312\\python.exe",
      "C:\\Python311\\python.exe",
      "C:\\Python310\\python.exe",
      path.join(localAppData, "Programs", "Python", "Python312", "python.exe"),
      path.join(localAppData, "Programs", "Python", "Python311", "python.exe"),
      path.join(localAppData, "Programs", "Python", "Python310", "python.exe"),
      path.join(programFiles, "Python312", "python.exe"),
      path.join(programFiles, "Python311", "python.exe"),
      path.join(programFiles, "Python310", "python.exe"),
    ];
    for (const pythonPath of pathCandidates) {
      commandCandidates.push({
        command: pythonPath,
        args: [],
        label: pythonPath,
        path: pythonPath,
        requiresExistingPath: true,
      });
    }
  }

  return await detectSupportedPython({
    candidates: commandCandidates,
    inspectCandidate: async (candidate) => {
      if (candidate.requiresExistingPath && !fs.existsSync(candidate.command)) {
        return {
          success: false,
          notFound: true,
          osCode: "ENOENT",
          error: `Python executable does not exist: ${candidate.command}`,
        };
      }
      return await getPythonVersionFromCommand(candidate.command, candidate.args || [], {
        env: getCleanPythonCommandEnv(),
      });
    },
  });
}

async function detectConda() {
  try {
    const { stdout, stderr } = await execCondaCommand(["--version"], {
      timeout: 15000,
    });
    const message = `${stdout || ""}\n${stderr || ""}`.trim();
    if (!message) {
      return { success: false, error: "Conda command returned empty output." };
    }
    return { success: true, version: message };
  } catch (error) {
    const details = `${error?.message || ""}\n${error?.diagnostic?.stderrTail || ""}`;
    const notFound =
      error?.osCode === "ENOENT" ||
      error?.diagnostic?.osCode === "ENOENT" ||
      /not recognized|command not found|不是内部或外部命令/i.test(details);
    return {
      success: false,
      code: notFound ? "CONDA_NOT_FOUND" : "CONDA_UNUSABLE",
      error: error.userMessage || error.message || "Conda was not detected.",
      diagnostic: error.diagnostic,
    };
  }
}

async function getCondaEnvironmentList(options = {}) {
  const { stdout } = await execCondaCommand(["env", "list", "--json"], {
    timeout: 30000,
    ...options,
  });
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || ""));
  } catch (error) {
    throw new Error(`Conda returned an invalid environment list: ${error.message}`);
  }
  if (!Array.isArray(parsed?.envs)) {
    throw new Error("Conda environment list did not contain an envs array.");
  }
  return parsed.envs.map((envPath) => path.normalize(String(envPath)));
}

function hasNamedCondaEnvironment(environments, environmentName) {
  const expectedName = String(environmentName || "").trim().toLowerCase();
  return environments.some(
    (environmentPath) => path.basename(environmentPath).toLowerCase() === expectedName
  );
}

async function probeCondaDependencies(environmentName, modules, options = {}) {
  const probeDirectory = path.join(app.getPath("temp"), "moonshine-startup-probes");
  const probePath = path.join(probeDirectory, `import-probe-${crypto.randomUUID()}.py`);
  const probeArgs = [
    "run",
    "-n",
    environmentName,
    "python",
    probePath,
  ];
  try {
    fs.mkdirSync(probeDirectory, { recursive: true });
    fs.writeFileSync(probePath, buildImportProbeScript(modules), "utf8");
    const { stdout, stderr } = await execCondaCommand(probeArgs, options);
    return parseImportProbeResult({ stdout, stderr, exitCode: 0 });
  } catch (error) {
    const diagnostic = error?.diagnostic;
    return {
      ...parseImportProbeResult({
        stdout: diagnostic?.stdoutTail || error?.stdout || "",
        stderr: diagnostic?.stderrTail || error?.stderr || error?.message || "",
        exitCode: diagnostic?.exitCode ?? error?.exitCode ?? null,
      }),
      diagnostic,
      attempts: diagnostic?.attempts || error?.attempts,
    };
  } finally {
    fs.rmSync(probePath, { force: true });
  }
}

function createDependencyCheckResponse(dependencyResult, options = {}) {
  const response = {
    success: dependencyResult.success,
    missingModules: dependencyResult.missingModules,
    dependencyErrors: dependencyResult.errors,
    error: dependencyResult.success ? undefined : dependencyResult.error,
    diagnostic: dependencyResult.diagnostic,
    attempts: dependencyResult.attempts,
    message: dependencyResult.success
      ? options.successMessage || "Backend dependencies are ready."
      : dependencyResult.error,
  };
  if (response.success) return response;
  return augmentStartupFailure(
    {
      ...response,
      code: options.code || "PYTHON_DEPENDENCIES_MISSING",
    },
    { stage: options.stage || "check-dependencies" }
  );
}

async function createProjectVenvWithPython(projectPath, pythonCommand, pythonArgs = [], sendLog) {
  const label = formatCommandLabel(pythonCommand, pythonArgs);
  const venvPath = path.join(projectPath, ".venv");
  const existedBefore = fs.existsSync(venvPath);
  sendLog?.(`Creating project virtual environment with ${label}...`, "info");
  try {
    await execFileCommand(pythonCommand, [...pythonArgs, "-m", "venv", ".venv"], {
      cwd: projectPath,
      env: getCleanPythonCommandEnv(),
      timeout: 180000,
      stage: "create-project-venv",
      failureCode: "PROJECT_VENV_CREATE_FAILED",
      userMessage: "Failed to create the project virtual environment.",
    });

    const venvInfo = await getUsableProjectVenvInfo(projectPath);
    if (!venvInfo.exists || !venvInfo.valid) {
      throw new Error(
        venvInfo.error || "Virtual environment creation finished, but .venv is invalid."
      );
    }
    return venvInfo;
  } catch (error) {
    if (!existedBefore && fs.existsSync(venvPath)) {
      fs.rmSync(venvPath, { recursive: true, force: true });
    }
    throw error;
  }
}

async function bootstrapProjectVenvWithConda(projectPath, sendLog) {
  const tempEnvName = `moonshine-image-bootstrap-${Date.now()}`;
  const venvPath = path.join(projectPath, ".venv");
  const venvExistedBefore = fs.existsSync(venvPath);
  let createdTempEnv = false;
  try {
    sendLog?.(
      `Creating temporary conda environment (${tempEnvName}) with Python ${TARGET_PYTHON_VERSION}...`,
      "info"
    );
    await execCondaCommand(
      ["create", "-n", tempEnvName, `python=${TARGET_PYTHON_VERSION}`, "-y"],
      { timeout: 600000 }
    );
    createdTempEnv = true;

    sendLog?.("Creating .venv inside the backend project via conda Python...", "info");
    await execCondaCommand(["run", "-n", tempEnvName, "python", "-m", "venv", ".venv"], {
      cwd: projectPath,
      timeout: 600000,
    });

    const venvInfo = await getUsableProjectVenvInfo(projectPath);
    if (!venvInfo.exists || !venvInfo.valid) {
      throw new Error("Conda bootstrap completed, but .venv is invalid.");
    }
    return venvInfo;
  } catch (error) {
    if (!venvExistedBefore && fs.existsSync(venvPath)) {
      fs.rmSync(venvPath, { recursive: true, force: true });
    }
    throw error;
  } finally {
    if (createdTempEnv) {
      try {
        sendLog?.(`Removing temporary conda environment (${tempEnvName})...`, "info");
        await execCondaCommand(["env", "remove", "-n", tempEnvName, "-y"], {
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
      "https://www.python.org/ftp/python/3.12.11/python-3.12.11-amd64.exe",
    commands: [
      `cd /d "${safeProjectPath}"`,
      "py -3.12 -m venv .venv",
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
  const requiredDirs = ["moonshine_server"];
  const missingFiles = requiredFiles.filter(
    (fileName) => !fs.existsSync(path.join(checkPath, fileName))
  );
  const missingDirs = requiredDirs.filter((dirName) => {
    const dirPath = path.join(checkPath, dirName);
    return !fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory();
  });

  if (!isBackendProjectStructureComplete(checkPath)) {
    const runtimeBackendCleanupPaths = [
      path.join(app.getPath("userData"), "runtime", "backend"),
      getLegacyRuntimeBackendPath(),
    ];
    return {
      success: false,
      code: "PROJECT_STRUCTURE_INVALID",
      error: "Backend project structure is incomplete.",
      missingFiles,
      missingDirs,
      currentCheckPath: checkPath,
      runtimeBackendCleanupPaths,
      recoveryHint:
        `如果你是从旧版本更新，请删除 ${runtimeBackendCleanupPaths.join(" 或 ")} 后重试。`,
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

function getConfigDirectory() {
  const configPath = getConfigPath();
  return path.dirname(configPath);
}

function getSam3LexiconPath() {
  return path.join(getConfigDirectory(), "sam3-lexicon.json");
}

function normalizeSam3LexiconEntry(entry = {}, fallbackCategory = "") {
  const zh = String(entry.zh || "").trim();
  const en = String(entry.en || "").trim();
  if (!zh || !en) return null;
  const normalized = { zh, en };
  const category = String(entry.category || fallbackCategory || "").trim();
  if (category) normalized.category = category;
  return normalized;
}

function normalizeSam3LexiconPayload(payload = {}) {
  const defaults = createDefaultSam3Lexicon();
  const colors = Array.isArray(payload.colors)
    ? payload.colors.map((entry) => normalizeSam3LexiconEntry(entry)).filter(Boolean)
    : defaults.colors;
  const nouns = Array.isArray(payload.nouns)
    ? payload.nouns.map((entry) => normalizeSam3LexiconEntry(entry, "自定义")).filter(Boolean)
    : defaults.nouns;

  return {
    version: Number(payload.version || defaults.version) || defaults.version,
    colors: colors.length ? colors : defaults.colors,
    nouns: nouns.length ? nouns : defaults.nouns,
  };
}

function loadSam3Lexicon() {
  const lexiconPath = getSam3LexiconPath();
  if (!fs.existsSync(lexiconPath)) {
    const defaultLexicon = createDefaultSam3Lexicon();
    fs.writeFileSync(lexiconPath, JSON.stringify(defaultLexicon, null, 2), "utf8");
    return { ...defaultLexicon, path: lexiconPath, created: true };
  }

  const parsed = JSON.parse(fs.readFileSync(lexiconPath, "utf8"));
  const normalized = normalizeSam3LexiconPayload(parsed);
  if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
    fs.writeFileSync(lexiconPath, JSON.stringify(normalized, null, 2), "utf8");
  }
  return { ...normalized, path: lexiconPath, created: false };
}

function saveSam3Lexicon(payload = {}) {
  const lexiconPath = getSam3LexiconPath();
  const normalized = normalizeSam3LexiconPayload(payload);
  fs.writeFileSync(lexiconPath, JSON.stringify(normalized, null, 2), "utf8");
  return { ...normalized, path: lexiconPath, saved: true };
}

function createRuntimeDefaultConfig() {
  const userDataPath = app.getPath("userData");
  const nextConfig = createDefaultAppConfig();
  nextConfig.fileManagement.downloadPath = path.join(userDataPath, "downloads");
  nextConfig.fileManagement.tempPath = path.join(userDataPath, "temp");
  nextConfig.general.modelDir = getDefaultModelDir();
  nextConfig.general.backendProjectPath = getDefaultBackendProjectPath();
  nextConfig.general.defaultModel = "lama";
  nextConfig.masking.defaultSamModel = DEFAULT_MASKING_CONFIG.defaultSamModel;
  nextConfig.masking.defaultSam1Model = DEFAULT_MASKING_CONFIG.defaultSam1Model;
  nextConfig.masking.defaultSam2Model = DEFAULT_MASKING_CONFIG.defaultSam2Model;
  nextConfig.masking.defaultSam3Model = DEFAULT_MASKING_CONFIG.defaultSam3Model;
  nextConfig.masking.imageSmartSelectionDefaultModel =
    DEFAULT_MASKING_CONFIG.imageSmartSelectionDefaultModel;
  nextConfig.masking.videoSmartSelectionDefaultModel =
    DEFAULT_MASKING_CONFIG.videoSmartSelectionDefaultModel;
  nextConfig.video.tempFramesPath = path.join(userDataPath, "temp", "video_frames");
  return nextConfig;
}

function mergeConfigWithDefaults(config = {}) {
  const migratedConfig = migrateLegacyConfigShape(config);
  const merged = alignConfigWithDefaultSchema(createRuntimeDefaultConfig(), migratedConfig);
  merged.schemaVersion = CONFIG_SCHEMA_VERSION;
  return merged;
}

async function getUsableProjectVenvInfo(projectPath, options = {}) {
  const venvInfo = getProjectVenvInfo(projectPath);
  if (!venvInfo.exists || !venvInfo.valid) {
    return venvInfo;
  }

  const versionResult = await getPythonVersionFromCommand(venvInfo.pythonPath, [], {
    cwd: projectPath,
    env: getIsolatedPythonCommandEnv(venvInfo.venvPath),
    signal: options.signal,
  });
  if (!versionResult.success) {
    return {
      ...venvInfo,
      valid: false,
      error: `${venvInfo.venvName} exists, but its Python executable is unusable. ${versionResult.error}`,
    };
  }
  if (!isSupportedPythonVersion(versionResult.version)) {
    return {
      ...venvInfo,
      valid: false,
      pythonVersion: versionResult.version.text,
      error: `${venvInfo.venvName} uses unsupported Python ${versionResult.version.text}. Supported versions are 3.10.x to 3.12.x.`,
    };
  }

  return {
    ...venvInfo,
    pythonVersion: versionResult.version.text,
  };
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

  const checkPath = integrityResult.runtimeProjectPath || effectivePath;
  return validateProjectPath(checkPath);
}

function sanitizeAppConfig(config = {}) {
  const merged = mergeConfigWithDefaults(config);
  merged.general.backendPort = normalizeInteger(merged.general?.backendPort, 8080, 1024, 65535);
  merged.general.launchMode = ["cuda", "cpu"].includes(merged.general?.launchMode)
    ? merged.general.launchMode
    : "cuda";
  merged.general.defaultModel = normalizeDefaultBackendModel(
    merged.general?.defaultModel,
    merged.general.launchMode
  );
  merged.general.autoStart = normalizeBoolean(merged.general?.autoStart, true);
  merged.general.backendProjectPath = normalizeStoredBackendProjectPath(
    merged.general.backendProjectPath
  );
  merged.ui.showStartupAnimation = normalizeBoolean(merged.ui?.showStartupAnimation, true);
  merged.fileManagement.tempCleanup = {
    enabled: normalizeBoolean(
      merged.fileManagement?.tempCleanup?.enabled,
      DEFAULT_TEMP_CLEANUP.enabled
    ),
    onStartup: normalizeBoolean(
      merged.fileManagement?.tempCleanup?.onStartup,
      DEFAULT_TEMP_CLEANUP.onStartup
    ),
    maxAgeDays: normalizeInteger(
      merged.fileManagement?.tempCleanup?.maxAgeDays,
      DEFAULT_TEMP_CLEANUP.maxAgeDays,
      1,
      365
    ),
    includeImages: normalizeBoolean(
      merged.fileManagement?.tempCleanup?.includeImages,
      DEFAULT_TEMP_CLEANUP.includeImages
    ),
    includeVideos: normalizeBoolean(
      merged.fileManagement?.tempCleanup?.includeVideos,
      DEFAULT_TEMP_CLEANUP.includeVideos
    ),
    keepRecentFailures: normalizeBoolean(
      merged.fileManagement?.tempCleanup?.keepRecentFailures,
      DEFAULT_TEMP_CLEANUP.keepRecentFailures
    ),
  };
  merged.advanced.imageProcessingMethod = IMAGE_PROCESSING_METHOD_OPTIONS.includes(
    merged.advanced?.imageProcessingMethod
  )
    ? merged.advanced.imageProcessingMethod
    : "auto";
  merged.advanced.imageOutputFormat = IMAGE_OUTPUT_FORMAT_OPTIONS.includes(
    String(merged.advanced?.imageOutputFormat || "").toLowerCase()
  )
    ? String(merged.advanced.imageOutputFormat).toLowerCase()
    : "auto";
  merged.advanced.imageOutputQuality = normalizeInteger(
    merged.advanced?.imageOutputQuality,
    DEFAULT_IMAGE_OUTPUT_QUALITY,
    1,
    100
  );
  merged.advanced.imageOutputNamingMode = IMAGE_OUTPUT_NAMING_MODES.includes(
    merged.advanced?.imageOutputNamingMode
  )
    ? merged.advanced.imageOutputNamingMode
    : "original";
  merged.advanced.imageOutputFixedPrefix =
    String(merged.advanced?.imageOutputFixedPrefix || "moonshine").trim() || "moonshine";
  merged.advanced.videoProcessingEngine = VIDEO_PROCESSING_ENGINE_OPTIONS.includes(
    merged.advanced?.videoProcessingEngine
  )
    ? merged.advanced.videoProcessingEngine
    : "auto";
  merged.masking.defaultSamModel =
    String(merged.masking?.defaultSamModel || "").trim() ||
    DEFAULT_MASKING_CONFIG.defaultSamModel;
  merged.masking.defaultSam1Model =
    String(merged.masking?.defaultSam1Model || merged.masking?.defaultSamModel || "").trim() ||
    DEFAULT_MASKING_CONFIG.defaultSam1Model;
  merged.masking.defaultSam2Model =
    String(merged.masking?.defaultSam2Model || "").trim() ||
    DEFAULT_MASKING_CONFIG.defaultSam2Model;
  merged.masking.defaultSam3Model =
    String(merged.masking?.defaultSam3Model || "").trim() ||
    DEFAULT_MASKING_CONFIG.defaultSam3Model;
  merged.masking.imageSmartSelectionDefaultModel =
    String(merged.masking?.imageSmartSelectionDefaultModel || "").trim() ||
    String(merged.masking?.defaultSamModel || merged.masking?.defaultSam1Model || "").trim() ||
    DEFAULT_MASKING_CONFIG.imageSmartSelectionDefaultModel;
  merged.masking.videoSmartSelectionDefaultModel =
    String(merged.masking?.videoSmartSelectionDefaultModel || "").trim() ||
    String(merged.masking?.defaultSam2Model || "").trim() ||
    DEFAULT_MASKING_CONFIG.videoSmartSelectionDefaultModel;
  merged.masking.samReleaseBeforeProcessing = normalizeBoolean(
    merged.masking?.samReleaseBeforeProcessing,
    DEFAULT_MASKING_CONFIG.samReleaseBeforeProcessing
  );
  merged.shortcuts = normalizeShortcutConfig(merged.shortcuts);
  if (isLegacyDefaultModelDir(merged.general.modelDir)) {
    merged.general.modelDir = getDefaultModelDir();
  }
  if (app.isPackaged && isBundledBackendMode(merged.general.backendProjectPath)) {
    merged.general.modelDir = merged.general.modelDir || getDefaultModelDir();
  }
  delete merged.general.modelPath;
  if (merged?.video && Object.prototype.hasOwnProperty.call(merged.video, "outputPath")) {
    delete merged.video.outputPath;
  }
  if (merged?.video && Object.prototype.hasOwnProperty.call(merged.video, "maxFrameCount")) {
    delete merged.video.maxFrameCount;
  }
  merged.video.historyLimit = normalizeInteger(merged.video?.historyLimit, 5, 1, 50);
  merged.video.batchFrameCount = normalizeInteger(merged.video?.batchFrameCount, 120, 1);
  merged.video.batchRetryCount = normalizeInteger(merged.video?.batchRetryCount, 3, 1, 10);
  merged.video.failureRetentionCount = normalizeInteger(
    merged.video?.failureRetentionCount,
    3,
    1,
    50
  );
  merged.video.proxyMaxSide = normalizeInteger(merged.video?.proxyMaxSide, 1280, 256, 4096);
  merged.video.previewTrialSeconds = [3, 10].includes(Number(merged.video?.previewTrialSeconds))
    ? Number(merged.video.previewTrialSeconds)
    : 3;
  merged.video.frameExtractionFormat = ["jpg", "jpeg", "png", "webp"].includes(
    String(merged.video?.frameExtractionFormat || "").toLowerCase()
  )
    ? String(merged.video.frameExtractionFormat).toLowerCase()
    : "jpg";
  merged.video.intermediateFrameStrategy = VIDEO_INTERMEDIATE_FRAME_STRATEGY_OPTIONS.includes(
    merged.video?.intermediateFrameStrategy
  )
    ? merged.video.intermediateFrameStrategy
    : "performance";
  merged.video.encodingQualityPreset = VIDEO_ENCODING_QUALITY_PRESET_OPTIONS.includes(
    merged.video?.encodingQualityPreset
  )
    ? merged.video.encodingQualityPreset
    : "performance";
  merged.video.inpaintColorStabilization = VIDEO_INPAINT_COLOR_STABILIZATION_OPTIONS.includes(
    merged.video?.inpaintColorStabilization
  )
    ? merged.video.inpaintColorStabilization
    : "auto";
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
      !config.masking ||
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

    if (
      config.general.defaultModel &&
      !DEFAULT_BACKEND_MODEL_IDS.includes(
        String(config.general.defaultModel).trim().toLowerCase()
      )
    ) {
      return false;
    }

    if (
      typeof config.masking.defaultSamModel !== "string" ||
      typeof config.masking.defaultSam1Model !== "string" ||
      typeof config.masking.defaultSam2Model !== "string" ||
      typeof config.masking.defaultSam3Model !== "string" ||
      typeof config.masking.imageSmartSelectionDefaultModel !== "string" ||
      typeof config.masking.videoSmartSelectionDefaultModel !== "string" ||
      typeof config.masking.samReleaseBeforeProcessing !== "boolean"
    ) {
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
      !IMAGE_PROCESSING_METHOD_OPTIONS.includes(config.advanced.imageProcessingMethod)
    ) {
      return false;
    }

    if (
      config.advanced?.imageOutputFormat &&
      !IMAGE_OUTPUT_FORMAT_OPTIONS.includes(config.advanced.imageOutputFormat)
    ) {
      return false;
    }

    if (
      typeof config.advanced?.imageOutputQuality !== "number" ||
      Number.isNaN(config.advanced.imageOutputQuality) ||
      !Number.isInteger(config.advanced.imageOutputQuality) ||
      config.advanced.imageOutputQuality < 1 ||
      config.advanced.imageOutputQuality > 100
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
      config.advanced?.videoProcessingEngine &&
      !VIDEO_PROCESSING_ENGINE_OPTIONS.includes(config.advanced.videoProcessingEngine)
    ) {
      return false;
    }

    const tempCleanup = config.fileManagement?.tempCleanup;
    if (!isPlainObject(tempCleanup)) {
      return false;
    }
    const tempCleanupKeys = Object.keys(tempCleanup);
    if (
      tempCleanupKeys.length !== Object.keys(DEFAULT_TEMP_CLEANUP).length ||
      tempCleanupKeys.some(
        (key) => !Object.prototype.hasOwnProperty.call(DEFAULT_TEMP_CLEANUP, key)
      )
    ) {
      return false;
    }
    if (
      [
        tempCleanup.enabled,
        tempCleanup.onStartup,
        tempCleanup.includeImages,
        tempCleanup.includeVideos,
        tempCleanup.keepRecentFailures,
      ].some((value) => typeof value !== "boolean")
    ) {
      return false;
    }
    if (
      typeof tempCleanup.maxAgeDays !== "number" ||
      Number.isNaN(tempCleanup.maxAgeDays) ||
      !Number.isInteger(tempCleanup.maxAgeDays) ||
      tempCleanup.maxAgeDays < 1 ||
      tempCleanup.maxAgeDays > 365
    ) {
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

    if (
      config.video.intermediateFrameStrategy &&
      !VIDEO_INTERMEDIATE_FRAME_STRATEGY_OPTIONS.includes(config.video.intermediateFrameStrategy)
    ) {
      return false;
    }

    if (
      config.video.encodingQualityPreset &&
      !VIDEO_ENCODING_QUALITY_PRESET_OPTIONS.includes(config.video.encodingQualityPreset)
    ) {
      return false;
    }

    if (
      config.video.inpaintColorStabilization &&
      !VIDEO_INPAINT_COLOR_STABILIZATION_OPTIONS.includes(
        config.video.inpaintColorStabilization
      )
    ) {
      return false;
    }

    if (
      config.video.previewTrialSeconds !== undefined &&
      ![3, 10].includes(Number(config.video.previewTrialSeconds))
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
        if (
          needsConfigMigration(configData) ||
          JSON.stringify(configData) !== JSON.stringify(sanitizedConfig)
        ) {
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
    const defaultConfig = createRuntimeDefaultConfig();
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
    globalConfig = sanitizeAppConfig(defaultConfig);
    global.projectPath = globalConfig.general.backendProjectPath || "";

    [
      globalConfig.fileManagement.downloadPath,
      globalConfig.fileManagement.tempPath,
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

function runStartupTempCleanup() {
  const cleanupOptions = normalizeTempCleanupOptions(globalConfig.fileManagement?.tempCleanup);
  if (!cleanupOptions.enabled || !cleanupOptions.onStartup) {
    return;
  }

  try {
    const result = cleanupAppTempFiles(cleanupOptions);
    if (result?.success) {
      const data = result.data || {};
      console.log(
        [
          "Startup temp cleanup completed:",
          `files=${Number(data.removedFileCount || 0)}`,
          `directories=${Number(data.removedDirectoryCount || 0)}`,
          `videoTasks=${Number(data.removedTaskCount || 0)}`,
          `bytes=${Number(data.removedBytes || 0)}`,
        ].join(" ")
      );
    } else {
      console.warn("Startup temp cleanup failed:", result?.error || "unknown error");
    }
  } catch (error) {
    console.warn("Startup temp cleanup failed:", error);
  }
}

// IPC handler - get app config
ipcMain.handle("get-app-config", async () => {
  return global.appConfig || globalConfig;
});

ipcMain.handle("get-sam3-lexicon", async () => {
  try {
    return { success: true, data: loadSam3Lexicon() };
  } catch (error) {
    console.error("Failed to load SAM3 lexicon:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("save-sam3-lexicon", async (event, payload) => {
  try {
    return { success: true, data: saveSam3Lexicon(payload) };
  } catch (error) {
    console.error("Failed to save SAM3 lexicon:", error);
    return { success: false, error: error.message };
  }
});

// IPC handler - save app config
ipcMain.handle("save-app-config", async (event, newConfig) => {
  try {
    if (!newConfig || typeof newConfig !== "object") {
      console.error("Invalid configuration payload:", newConfig);
      return { success: false, error: "Invalid configuration payload" };
    }
    if (!validateConfig(mergeConfigForStrictValidation(newConfig))) {
      console.error("Configuration validation failed before sanitization:", newConfig);
      return { success: false, error: "Invalid configuration payload" };
    }
    const sanitizedConfig = sanitizeAppConfig(newConfig);
    if (!validateConfig(sanitizedConfig)) {
      console.error("Configuration validation failed:", newConfig);
      return { success: false, error: "Invalid configuration payload" };
    }

    const backendPathValidation = buildBackendPathValidationResult({
      backendProjectPath: sanitizedConfig.general?.backendProjectPath || "",
      modelDir: sanitizedConfig.general?.modelDir || "",
    });
    if (!backendPathValidation.valid) {
      return {
        success: false,
        error: backendPathValidation.message,
        code: backendPathValidation.code,
        invalidPaths: backendPathValidation.invalidPaths,
      };
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
    const buffer = Buffer.from(blob);
    ensureDiskSpace(filePath, {
      requiredBytes: buffer.byteLength,
      operation: "保存文件",
    });
    fs.writeFileSync(filePath, buffer);

    return filePath;
  } catch (error) {
    console.error("Failed to save file:", error);
    throw error;
  }
};
ipcMain.handle("save-file", saveFileHandler);
ipcMain.handle("saveFile", saveFileHandler);
ipcMain.handle("check-disk-space", async (event, targetPath) => {
  try {
    return getAvailableDiskSpace(targetPath);
  } catch (error) {
    return { success: false, error: error.message };
  }
});
ipcMain.handle("ensure-disk-space", async (event, payload = {}) => {
  try {
    return ensureDiskSpace(payload.targetPath || payload.path, payload);
  } catch (error) {
    return {
      success: false,
      ok: false,
      error: error.message,
    };
  }
});
ipcMain.handle("open-file-write-stream", async (event, payload = {}) => {
  try {
    const filePath = typeof payload === "string" ? payload : payload.filePath;
    const resolvedFilePath = resolveWritableFilePath(filePath);
    ensureDiskSpace(resolvedFilePath, {
      requiredBytes: payload.estimatedBytes || payload.requiredBytes || 0,
      safetyBytes: payload.safetyBytes,
      operation: payload.operation || "创建输出文件",
    });
    const stream = fs.createWriteStream(resolvedFilePath);
    await waitForWriteStreamOpen(stream);

    const streamId = `file_stream_${Date.now()}_${nextFileWriteStreamId++}`;
    activeFileWriteStreams.set(streamId, {
      stream,
      filePath: resolvedFilePath,
      operation: payload.operation || "写入输出文件",
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
      ensureDiskSpace(session.filePath, {
        requiredBytes: getBufferByteLength(chunk),
        operation: session.operation || "写入输出文件",
      });
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

function getFfmpegCandidateBinRoots() {
  const roots = [];
  const envRoot = String(process.env.MOONSHINE_FFMPEG_ROOT || "").trim();
  if (envRoot) {
    roots.push(envRoot, path.join(envRoot, "bin"));
  }

  if (app.isPackaged) {
    roots.push(getPackagedFfmpegResourceRootPath());
  } else {
    roots.push("C:\\code\\ffmpeg\\bin", "C:\\code\\ffmpeg");
  }

  return Array.from(new Set(roots.map((entry) => path.normalize(entry))));
}

function getFfmpegExecutablePath(binaryName) {
  const executableName = os.platform() === "win32" ? `${binaryName}.exe` : binaryName;

  for (const binRoot of getFfmpegCandidateBinRoots()) {
    const candidatePath = path.join(binRoot, executableName);
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return "";
}

function getFfmpegRuntimeInfo() {
  const ffmpegPath = getFfmpegExecutablePath("ffmpeg");
  const ffprobePath = getFfmpegExecutablePath("ffprobe");

  return {
    ffmpegPath,
    ffprobePath,
    binRoot: ffmpegPath ? path.dirname(ffmpegPath) : "",
    packaged: app.isPackaged,
  };
}

function ensureFfmpegRuntime() {
  const runtime = getFfmpegRuntimeInfo();
  const missing = [];
  if (!runtime.ffmpegPath) missing.push("ffmpeg");
  if (!runtime.ffprobePath) missing.push("ffprobe");
  if (missing.length > 0) {
    throw new Error(
      `FFmpeg runtime is incomplete. Missing: ${missing.join(", ")}.`
    );
  }
  return runtime;
}

function normalizeFfmpegFps(value) {
  const fps = Number(value);
  if (!Number.isFinite(fps) || fps <= 0) {
    return 30;
  }
  return Math.min(240, Math.max(1, fps));
}

function normalizeFfmpegCrf(value, fallback = 18) {
  const crf = Number(value);
  if (!Number.isFinite(crf)) {
    return fallback;
  }
  return Math.max(0, Math.min(51, Math.round(crf)));
}

function normalizeFfmpegImageFormat(value, fallback = "jpg") {
  const normalized = String(value || fallback).toLowerCase();
  if (["jpg", "jpeg", "png", "webp"].includes(normalized)) {
    return normalized === "jpeg" ? "jpg" : normalized;
  }
  return fallback;
}

function normalizeImageQuality(value, fallback = 0.95) {
  const quality = Number(value);
  if (!Number.isFinite(quality)) {
    return fallback;
  }
  return Math.max(0.1, Math.min(1, quality));
}

function jpegQualityToFfmpegQScale(value) {
  const quality = normalizeImageQuality(value);
  return Math.max(2, Math.min(31, Math.round(32 - quality * 32)));
}

const UNKNOWN_FFMPEG_COLOR_VALUES = new Set([
  "",
  "unknown",
  "unspecified",
  "reserved",
  "n/a",
  "na",
]);

function normalizeFfmpegColorToken(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (UNKNOWN_FFMPEG_COLOR_VALUES.has(normalized)) {
    return "";
  }
  return normalized;
}

function inferDefaultVideoColorToken({ width = 0, height = 0 } = {}) {
  const w = Math.max(0, Number(width || 0));
  const h = Math.max(0, Number(height || 0));
  return Math.max(w, h) >= 1280 ? "bt709" : "smpte170m";
}

function normalizeFfmpegColorRange(value, fallback = "tv") {
  const normalized = String(value || "").trim().toLowerCase();
  if (["pc", "jpeg", "full"].includes(normalized)) {
    return "pc";
  }
  if (["tv", "mpeg", "limited"].includes(normalized)) {
    return "tv";
  }
  return fallback;
}

function normalizeVideoColorMetadata(metadata = {}, fallback = {}) {
  const width = Number(metadata.width || fallback.width || 0);
  const height = Number(metadata.height || fallback.height || 0);
  const defaultToken = inferDefaultVideoColorToken({ width, height });
  const colorSpace =
    normalizeFfmpegColorToken(metadata.color_space || metadata.colorspace) || defaultToken;
  const colorPrimaries =
    normalizeFfmpegColorToken(metadata.color_primaries || metadata.colorPrimaries) ||
    defaultToken;
  const colorTransfer =
    normalizeFfmpegColorToken(
      metadata.color_transfer || metadata.color_trc || metadata.colorTransfer
    ) || defaultToken;

  return {
    width,
    height,
    pix_fmt: String(metadata.pix_fmt || metadata.pixFmt || "").trim(),
    source_color_range: String(metadata.color_range || metadata.colorRange || "").trim(),
    color_range: normalizeFfmpegColorRange(metadata.color_range || metadata.colorRange, "tv"),
    encode_color_range: "tv",
    color_space: colorSpace,
    color_primaries: colorPrimaries,
    color_transfer: colorTransfer,
    color_trc: colorTransfer,
    inferred: Boolean(
      !normalizeFfmpegColorToken(metadata.color_space || metadata.colorspace) ||
        !normalizeFfmpegColorToken(metadata.color_primaries || metadata.colorPrimaries) ||
        !normalizeFfmpegColorToken(
          metadata.color_transfer || metadata.color_trc || metadata.colorTransfer
        )
    ),
  };
}

function extractVideoColorMetadataFromProbeData(data = {}, fallback = {}) {
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const videoStream =
    streams.find((stream) => stream?.codec_type === "video") || streams[0] || {};
  return normalizeVideoColorMetadata(videoStream, {
    width: videoStream.width || fallback.width,
    height: videoStream.height || fallback.height,
  });
}

async function probeVideoColorMetadata(inputPath, fallback = {}) {
  const result = await runFfprobe([
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-select_streams",
    "v:0",
    inputPath,
  ]);
  const data = JSON.parse(result.stdout || "{}");
  return extractVideoColorMetadataFromProbeData(data, fallback);
}

function buildFfmpegOutputColorArgs(metadata = {}, fallback = {}) {
  const color = normalizeVideoColorMetadata(metadata, fallback);
  return [
    "-pix_fmt",
    "yuv420p",
    "-color_range",
    color.encode_color_range,
    "-colorspace",
    color.color_space,
    "-color_primaries",
    color.color_primaries,
    "-color_trc",
    color.color_trc,
  ];
}

function buildFfmpegExtractionFilter({ fps, colorMetadata } = {}) {
  const safeFps = normalizeFfmpegFps(fps);
  const color = normalizeVideoColorMetadata(colorMetadata || {});
  const sourceRange = normalizeFfmpegColorRange(color.color_range, "tv");
  return [
    `fps=${safeFps}`,
    `scale=iw:ih:in_range=${sourceRange}:out_range=pc:in_color_matrix=${color.color_space}`,
  ].join(",");
}

function buildFfmpegEncodeFilter(metadata = {}, fallback = {}) {
  const color = normalizeVideoColorMetadata(metadata, fallback);
  return `scale=trunc(iw/2)*2:trunc(ih/2)*2:in_range=pc:out_range=tv:out_color_matrix=${color.color_space}`;
}

function escapeFfconcatPath(filePath) {
  return String(filePath || "")
    .replace(/\\/g, "/")
    .replace(/'/g, "'\\''");
}

function createTemporaryConcatFile(outputPath, lines) {
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const listPath = path.join(
    outputDir,
    `ffmpeg_concat_${Date.now()}_${Math.random().toString(16).slice(2, 8)}.ffconcat`
  );
  fs.writeFileSync(listPath, `${lines.join("\n")}\n`, "utf8");
  return listPath;
}

function createFrameSequenceConcatFile(framePaths, outputPath, fps) {
  const duration = 1 / normalizeFfmpegFps(fps);
  const lines = ["ffconcat version 1.0"];
  framePaths.forEach((framePath) => {
    lines.push(`file '${escapeFfconcatPath(framePath)}'`);
    lines.push(`duration ${duration.toFixed(8)}`);
  });
  lines.push(`file '${escapeFfconcatPath(framePaths[framePaths.length - 1])}'`);
  return createTemporaryConcatFile(outputPath, lines);
}

function createSegmentConcatFile(segmentPaths, outputPath) {
  const lines = segmentPaths.map((segmentPath) => `file '${escapeFfconcatPath(segmentPath)}'`);
  return createTemporaryConcatFile(outputPath, lines);
}

function getProcessOutputTail(text, maxLength = 2400) {
  const normalized = String(text || "").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.slice(normalized.length - maxLength);
}

function runManagedFfmpegProcess(command, args = [], options = {}) {
  const taskId =
    options.taskId ||
    `ffmpeg_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: getUtf8ProcessEnv(options.env),
    });

    let stdout = "";
    let stderr = "";
    activeFfmpegTasks.set(taskId, child);

    const handleOutput = (data, target) => {
      const text = decodeProcessOutput(data);
      if (target === "stdout") {
        stdout += text;
      } else {
        stderr += text;
        if (options.event?.sender && options.progressEventName) {
          options.event.sender.send(options.progressEventName, {
            taskId,
            stderr: text,
          });
        }
      }
    };

    child.stdout?.on("data", (data) => handleOutput(data, "stdout"));
    child.stderr?.on("data", (data) => handleOutput(data, "stderr"));
    child.on("error", (error) => {
      activeFfmpegTasks.delete(taskId);
      reject(error);
    });
    child.on("close", (code) => {
      activeFfmpegTasks.delete(taskId);
      if (code === 0) {
        resolve({ taskId, stdout, stderr });
        return;
      }

      reject(
        new Error(
          [
            `FFmpeg exited with code ${code}.`,
            getProcessOutputTail(stderr) || getProcessOutputTail(stdout),
          ]
            .filter(Boolean)
            .join("\n")
        )
      );
    });
  });
}

async function runFfmpeg(args = [], options = {}) {
  const runtime = ensureFfmpegRuntime();
  return runManagedFfmpegProcess(runtime.ffmpegPath, args, options);
}

async function runFfprobe(args = [], options = {}) {
  const runtime = ensureFfmpegRuntime();
  return runManagedFfmpegProcess(runtime.ffprobePath, args, options);
}

function validateExistingFiles(filePaths = [], label = "file") {
  const missingPaths = filePaths.filter((filePath) => !filePath || !fs.existsSync(filePath));
  if (missingPaths.length > 0) {
    const preview = missingPaths.slice(0, 3).join("; ");
    throw new Error(`${label} does not exist: ${preview}`);
  }
}

ipcMain.handle("check-ffmpeg-runtime", async () => {
  try {
    const runtime = ensureFfmpegRuntime();
    const [versionResult, probeVersionResult, encoderResult] = await Promise.all([
      runManagedFfmpegProcess(runtime.ffmpegPath, ["-version"]),
      runManagedFfmpegProcess(runtime.ffprobePath, ["-version"]),
      runManagedFfmpegProcess(runtime.ffmpegPath, ["-hide_banner", "-encoders"]),
    ]);
    const encoderText = encoderResult.stdout || encoderResult.stderr || "";
    const versionLine = String(versionResult.stdout || "")
      .split(/\r?\n/)
      .find(Boolean);
    const probeVersionLine = String(probeVersionResult.stdout || "")
      .split(/\r?\n/)
      .find(Boolean);

    return {
      success: true,
      data: {
        ...runtime,
        versionLine,
        probeVersionLine,
        hasLibx264: /\blibx264\b/.test(encoderText),
        hasAac: /\baac\b/.test(encoderText),
      },
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("ffprobe-media", async (event, { inputPath } = {}) => {
  try {
    validateExistingFiles([inputPath], "media");
    const result = await runFfprobe([
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      inputPath,
    ]);
    const data = JSON.parse(result.stdout || "{}");
    const streams = Array.isArray(data.streams) ? data.streams : [];
    return {
      success: true,
      data: {
        ...data,
        hasAudio: streams.some((stream) => stream.codec_type === "audio"),
        hasVideo: streams.some((stream) => stream.codec_type === "video"),
        colorMetadata: extractVideoColorMetadataFromProbeData(data),
      },
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("ffmpeg-extract-frame-sequence", async (event, payload = {}) => {
  try {
    const rawSourcePath = String(payload.sourcePath || payload.inputPath || "").trim();
    if (!rawSourcePath) {
      throw new Error("No source media path was provided.");
    }
    const sourcePath = path.normalize(rawSourcePath);
    validateExistingFiles([sourcePath], "media");

    const rawOutputDir = String(payload.outputDir || "").trim();
    if (!rawOutputDir) {
      throw new Error("No output directory was provided.");
    }
    const outputDir = path.normalize(rawOutputDir);
    fs.mkdirSync(outputDir, { recursive: true });

    const format = normalizeFfmpegImageFormat(payload.format, "jpg");
    const fps = normalizeFfmpegFps(payload.fps);
    const startFrame = Math.max(0, Math.round(Number(payload.startFrame || 0)));
    const requestedEndFrame = Number(payload.endFrame);
    const totalFrames = Math.max(0, Math.round(Number(payload.totalFrames || 0)));
    const endFrame = Number.isFinite(requestedEndFrame)
      ? Math.max(startFrame + 1, Math.round(requestedEndFrame))
      : Math.max(startFrame + 1, totalFrames || startFrame + 1);
    const frameCount = Math.max(1, endFrame - startFrame);
    const width = Math.max(1, Math.round(Number(payload.width || 0)));
    const height = Math.max(1, Math.round(Number(payload.height || 0)));
    const colorMetadata = await probeVideoColorMetadata(sourcePath, { width, height });
    const bytesPerPixel = format === "png" ? 3.25 : 0.55;

    ensureDiskSpace(outputDir, {
      requiredBytes: Math.ceil(Math.max(1, width) * Math.max(1, height) * frameCount * bytesPerPixel),
      operation: "FFmpeg 批量拆帧",
    });

    const outputPattern = path.join(outputDir, `frame_%06d.${format}`);
    const args = ["-y", "-hide_banner"];
    if (startFrame > 0) {
      args.push("-ss", (startFrame / fps).toFixed(6));
    }
    args.push(
      "-i",
      sourcePath,
      "-vf",
      buildFfmpegExtractionFilter({ fps, colorMetadata }),
      "-frames:v",
      String(frameCount),
      "-start_number",
      String(startFrame)
    );
    if (format === "jpg") {
      args.push("-q:v", String(jpegQualityToFfmpegQScale(payload.quality)));
    } else if (format === "png") {
      args.push("-compression_level", "3");
    }
    args.push(outputPattern);

    await runFfmpeg(args, {
      taskId: payload.taskId,
      event,
      progressEventName: "ffmpeg-progress",
    });

    const framePaths = [];
    const missingFrameIndexes = [];
    for (let index = startFrame; index < endFrame; index += 1) {
      const framePath = path.join(outputDir, `frame_${String(index).padStart(6, "0")}.${format}`);
      if (fs.existsSync(framePath)) {
        framePaths.push(framePath);
      } else {
        missingFrameIndexes.push(index);
      }
    }

    if (framePaths.length === 0) {
      throw new Error("FFmpeg did not write any frames.");
    }

    return {
      success: true,
      framePaths,
      startFrame,
      endFrame,
      missingFrameIndexes,
      colorMetadata,
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("ffmpeg-encode-frame-sequence", async (event, payload = {}) => {
  let listPath = "";
  try {
    const framePaths = Array.isArray(payload.framePaths) ? payload.framePaths : [];
    if (framePaths.length === 0) {
      throw new Error("No frame paths were provided.");
    }
    validateExistingFiles(framePaths, "frame");

    const outputPath = resolveWritableFilePath(payload.outputPath);
    ensureDiskSpace(outputPath, {
      requiredBytes:
        normalizeByteCount(payload.estimatedOutputBytes) ||
        sumExistingFileSizes(framePaths),
      operation: "编码临时视频分段",
    });
    const fps = normalizeFfmpegFps(payload.fps);
    listPath = createFrameSequenceConcatFile(framePaths, outputPath, fps);
    const colorMetadata = normalizeVideoColorMetadata(payload.colorMetadata || {}, {
      width: payload.width,
      height: payload.height,
    });

    await runFfmpeg(
      [
        "-y",
        "-hide_banner",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-r",
        String(fps),
        "-vf",
        buildFfmpegEncodeFilter(colorMetadata, {
          width: payload.width,
          height: payload.height,
        }),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        String(normalizeFfmpegCrf(payload.crf)),
        ...buildFfmpegOutputColorArgs(colorMetadata, {
          width: payload.width,
          height: payload.height,
        }),
        "-movflags",
        "+faststart",
        outputPath,
      ],
      {
        taskId: payload.taskId,
        event,
        progressEventName: "ffmpeg-progress",
      }
    );

    return { success: true, filePath: outputPath };
  } catch (error) {
    return { success: false, error: error.message };
  } finally {
    if (listPath && fs.existsSync(listPath)) {
      fs.rmSync(listPath, { force: true });
    }
  }
});

ipcMain.handle("ffmpeg-concat-segments", async (event, payload = {}) => {
  let listPath = "";
  try {
    const segmentPaths = Array.isArray(payload.segmentPaths) ? payload.segmentPaths : [];
    if (segmentPaths.length === 0) {
      throw new Error("No segment paths were provided.");
    }
    validateExistingFiles(segmentPaths, "segment");

    if (segmentPaths.length === 1) {
      const sourcePath = segmentPaths[0];
      const outputPath = path.normalize(String(payload.outputPath || sourcePath));
      if (path.normalize(sourcePath) === outputPath) {
        return { success: true, filePath: sourcePath };
      }
      const resolvedOutputPath = resolveWritableFilePath(outputPath);
      ensureDiskSpace(resolvedOutputPath, {
        requiredBytes: getFileSize(sourcePath),
        operation: "复制视频分段",
      });
      fs.copyFileSync(sourcePath, resolvedOutputPath);
      return { success: true, filePath: resolvedOutputPath };
    }

    const outputPath = resolveWritableFilePath(payload.outputPath);
    ensureDiskSpace(outputPath, {
      requiredBytes:
        normalizeByteCount(payload.estimatedOutputBytes) ||
        sumExistingFileSizes(segmentPaths),
      operation: "拼接视频分段",
    });
    listPath = createSegmentConcatFile(segmentPaths, outputPath);
    await runFfmpeg(
      [
        "-y",
        "-hide_banner",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        outputPath,
      ],
      {
        taskId: payload.taskId,
        event,
        progressEventName: "ffmpeg-progress",
      }
    );
    return { success: true, filePath: outputPath };
  } catch (error) {
    return { success: false, error: error.message };
  } finally {
    if (listPath && fs.existsSync(listPath)) {
      fs.rmSync(listPath, { force: true });
    }
  }
});

ipcMain.handle("ffmpeg-mux-audio", async (event, payload = {}) => {
  try {
    const { videoPath, sourcePath } = payload;
    validateExistingFiles([videoPath, sourcePath], "media");
    const outputPath = resolveWritableFilePath(payload.outputPath);
    ensureDiskSpace(outputPath, {
      requiredBytes:
        normalizeByteCount(payload.estimatedOutputBytes) ||
        getFileSize(videoPath) + Math.min(getFileSize(sourcePath), getFileSize(videoPath)),
      operation: "混合原视频音频",
    });
    await runFfmpeg(
      [
        "-y",
        "-hide_banner",
        "-i",
        videoPath,
        "-i",
        sourcePath,
        "-map",
        "0:v:0",
        "-map",
        "1:a?",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-shortest",
        "-movflags",
        "+faststart",
        outputPath,
      ],
      {
        taskId: payload.taskId,
        event,
        progressEventName: "ffmpeg-progress",
      }
    );
    return { success: true, filePath: outputPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("cancel-ffmpeg-task", async (event, taskId) => {
  try {
    const processToCancel = activeFfmpegTasks.get(taskId);
    if (!processToCancel) {
      return { success: true, canceled: false };
    }
    processToCancel.kill("SIGTERM");
    activeFfmpegTasks.delete(taskId);
    return { success: true, canceled: true };
  } catch (error) {
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
    ensureDiskSpace(finalTarget, {
      requiredBytes: getFileSize(source),
      operation: "复制文件",
    });
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
  const sendLog = createBackendOutputSender(event.sender, "check-python");

  try {
    sendLog("Checking Python environment...", "info");
    const pythonResult = await detectSystemPython();
    for (const attempt of pythonResult.attempts || []) {
      const versionLabel = attempt.version?.text ? ` (${attempt.version.text})` : "";
      const type = attempt.status === "supported" ? "success" :
        attempt.status === "not-found" ? "info" : "warning";
      sendLog(
        `${attempt.label}: ${attempt.status}${versionLabel}${attempt.reason ? ` - ${attempt.reason}` : ""}`,
        type,
        { diagnostic: attempt.diagnostic || undefined }
      );
    }
    if (pythonResult.success) {
      sendLog(`Using Python ${pythonResult.version.text}: ${pythonResult.label}`, "success");
      return {
        success: true,
        version: `Python ${pythonResult.version.text}`,
        pythonVersion: pythonResult.version.text,
        type: "python",
        command: pythonResult.command,
        args: pythonResult.args,
        path: pythonResult.path,
        attempts: pythonResult.attempts,
      };
    }

    sendLog("No supported system Python was selected. Checking Conda...", "info");
    const condaResult = await detectConda();
    if (condaResult.success) {
      sendLog(`Found Conda: ${condaResult.version}`, "success");
      return {
        success: true,
        version: condaResult.version,
        type: "conda",
        environmentPrepared: false,
        pythonFailure: pythonResult,
      };
    }

    const primaryFailure =
      pythonResult.code !== "SYSTEM_PYTHON_NOT_FOUND" ? pythonResult : condaResult;
    return toLoggedStartupFailure(new Error(primaryFailure.error), {
      code: primaryFailure.code || "PYTHON_RUNTIME_UNUSABLE",
      stage: "check-python",
      userMessage: primaryFailure.error || "No usable Python environment was detected.",
      recoveryHint:
        primaryFailure.code === "SYSTEM_PYTHON_UNSUPPORTED"
          ? "Install Python 3.10-3.12, or create a supported .venv in the backend project."
          : "Install or repair Python 3.10-3.12, then retry the environment check.",
      attempts: pythonResult.attempts,
      diagnostic: primaryFailure.diagnostic,
    });
  } catch (error) {
    sendLog(`Unexpected error while checking Python environment: ${error.message}`, "error");
    return toLoggedStartupFailure(error, {
      code: "PYTHON_ENVIRONMENT_CHECK_FAILED",
      stage: "check-python",
      userMessage: "Python environment check failed.",
    });
  }
});

// IPC handler - set Python environment variables
ipcMain.handle("set-python-env", async (event, pythonPath) => {
  try {
    const targetPath = String(pythonPath || "").trim();
    if (!targetPath) {
      return augmentStartupFailure(
        {
          success: false,
          code: "PYTHON_ENVIRONMENT_PATH_INVALID",
          error: "Python environment path is empty.",
        },
        {
          stage: "set-python-environment",
          recoveryHint: "Select a valid Python installation directory and retry.",
        }
      );
    }
    const currentEnv = process.env.PATH || "";
    const normalizeEntry = (entry) =>
      process.platform === "win32" ? entry.toLowerCase() : entry;
    const entries = currentEnv.split(path.delimiter).filter(Boolean);
    if (!entries.some((entry) => normalizeEntry(entry) === normalizeEntry(targetPath))) {
      process.env.PATH = [targetPath, ...entries].join(path.delimiter);
    }
    return { success: true, message: "Python environment variables updated successfully" };
  } catch (error) {
    return toLoggedStartupFailure(error, {
      code: "PYTHON_ENVIRONMENT_UPDATE_FAILED",
      stage: "set-python-environment",
      userMessage: "Failed to update the Python environment path.",
    });
  }
});

// IPC handler - check conda environment
ipcMain.handle("check-conda-venv", async () => {
  try {
    const environments = await getCondaEnvironmentList();
    const envExists = hasNamedCondaEnvironment(environments, "moonshine-image");
    if (!envExists) {
      return augmentStartupFailure(
        {
          success: false,
          code: "CONDA_ENVIRONMENT_NOT_FOUND",
          error: "Conda environment moonshine-image does not exist.",
          message: "Conda environment does not exist",
          environments,
        },
        {
          stage: "check-conda-environment",
          recoveryHint: "Create the moonshine-image Conda environment, then retry.",
        }
      );
    }
    return {
      success: true,
      message: "Conda environment exists",
      environments,
    };
  } catch (error) {
    return toLoggedStartupFailure(error, {
      code: "CONDA_ENVIRONMENT_CHECK_FAILED",
      stage: "check-conda-environment",
      userMessage: "Failed to check the Conda environment.",
    });
  }
});

// IPC handler - check conda dependencies
ipcMain.handle("check-conda-dependencies", async () => {
  try {
    const dependencyResult = await probeCondaDependencies(
      "moonshine-image",
      ["fastapi", "uvicorn", "numpy", "PIL"],
      {
      timeout: 30000,
      }
    );
    return createDependencyCheckResponse(dependencyResult, {
      code: "CONDA_DEPENDENCIES_MISSING",
      stage: "check-conda-dependencies",
      successMessage: "Conda dependencies are ready.",
    });
  } catch (error) {
    return toLoggedStartupFailure(error, {
      code: "CONDA_DEPENDENCY_CHECK_FAILED",
      stage: "check-conda-dependencies",
      userMessage: "Failed to check Conda dependencies.",
    });
  }
});
// IPC handler - validate project path
ipcMain.handle("validate-backend-paths", async (event, input = {}) => {
  return buildBackendPathValidationResult(input || {});
});

// IPC handler - validate project path
ipcMain.handle("check-project", async (event, selectPath) => {
  try {
    const backendPathValidation = buildBackendPathValidationResult({
      backendProjectPath: selectPath || global.projectPath || "",
      modelDir: globalConfig.general?.modelDir || "",
    });
    if (!backendPathValidation.valid) {
      return augmentStartupFailure(
        {
          success: false,
          code: backendPathValidation.code,
          error: backendPathValidation.message,
          recoveryHint: backendPathValidation.message,
          invalidPaths: backendPathValidation.invalidPaths,
        },
        { stage: "check-project" }
      );
    }

    const result = await resolveValidatedProjectPath(selectPath || global.projectPath);
    if (!result.success) {
      return augmentStartupFailure(result, { stage: "check-project" });
    }

    global.projectPath = result.path;
    return {
      success: true,
      path: result.path,
      backendMode: isBundledBackendMode(result.path) ? "bundled" : "external",
      defaultProjectPath: getDefaultBackendProjectPath(),
    };
  } catch (error) {
    return toLoggedStartupFailure(error, {
      code: error.startupCode || error.diagnostic?.code || "PROJECT_CHECK_FAILED",
      stage: "check-project",
      userMessage: "Failed to check the backend project path.",
    });
  }
});

ipcMain.handle("prepare-project-python", async (event, selectPath) => {
  const sendLog = createBackendOutputSender(event.sender, "prepare-project-python");

  try {
    const projectResult = await resolveValidatedProjectPath(
      selectPath || global.projectPath
    );
    if (!projectResult.success) {
      return augmentStartupFailure(projectResult, {
        stage: "prepare-project-python",
      });
    }

    global.projectPath = projectResult.path;
    const workingPath = projectResult.path;
    sendLog(`Backend project path: ${workingPath}`, "info");

    if (isBundledBackendMode(workingPath)) {
      sendLog("Using bundled offline backend mode.", "info");
      return await runStartupIpcOperation(
        () => ensureBundledRuntimeReady(sendLog),
        (error) =>
          toLoggedStartupFailure(error, {
            code:
              error.startupCode ||
              error.diagnostic?.code ||
              "BUNDLED_RUNTIME_PREPARATION_FAILED",
            stage: "prepare-project-python",
            userMessage: error.userMessage || "Bundled Python runtime preparation failed.",
            recoveryHint: error.recoveryHint,
          })
      );
    }

    const existingVenv = await getUsableProjectVenvInfo(workingPath);
    if (existingVenv.exists) {
      if (!existingVenv.valid) {
        const manualGuide = buildManualVenvGuide(workingPath);
        return augmentStartupFailure(
          {
            success: false,
            code: "INVALID_PROJECT_VENV",
            error:
              existingVenv.error ||
              "A virtual environment folder exists in the backend project, but it is invalid. Please fix it manually.",
            manualGuide,
            venvPath: existingVenv.venvPath,
            venvName: existingVenv.venvName,
          },
          { stage: "prepare-project-python" }
        );
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
        return augmentStartupFailure(
          {
            success: false,
            code: "SYSTEM_PYTHON_UNSUPPORTED",
            error: `Detected system Python ${systemPython.version.text}. Supported range is 3.10.x to 3.12.x. Please manually create a Python ${TARGET_PYTHON_VERSION} .venv inside the backend project.`,
            manualGuide,
            detectedPythonVersion: systemPython.version.text,
          },
          { stage: "prepare-project-python" }
        );
      }

      const venvInfo = await createProjectVenvWithPython(
        workingPath,
        systemPython.command,
        systemPython.args || [],
        sendLog
      );
      const versionResult = await getPythonVersionFromCommand(
        venvInfo.pythonPath
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
        venvInfo.pythonPath
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

    if (
      systemPython.code !== "SYSTEM_PYTHON_NOT_FOUND" ||
      condaResult.code !== "CONDA_NOT_FOUND"
    ) {
      const primaryFailure =
        systemPython.code !== "SYSTEM_PYTHON_NOT_FOUND" ? systemPython : condaResult;
      return augmentStartupFailure(
        {
          success: false,
          code: primaryFailure.code || "PYTHON_RUNTIME_UNUSABLE",
          error: primaryFailure.error || "The detected Python runtime is not usable.",
          recoveryHint:
            "Repair or remove the broken Python/Conda installation, or create a supported .venv manually.",
          diagnostic: primaryFailure.diagnostic,
          attempts: systemPython.attempts,
          manualGuide: buildManualVenvGuide(workingPath),
        },
        { stage: "prepare-project-python" }
      );
    }

    sendLog(
      `No system Python or conda was detected. Trying to install Python ${TARGET_PYTHON_VERSION} automatically...`,
      "warning"
    );
    const installResult = await installTargetPython(sendLog);
    if (!installResult.success) {
      return {
        ...installResult,
        manualGuide: buildManualVenvGuide(workingPath),
      };
    }
    if (installResult.success) {
      const installedVersion = await getPythonVersionFromCommand(
        installResult.pythonPath,
        [],
        { env: getCleanPythonCommandEnv() }
      );
      if (installedVersion.success && isSystemPythonVersionSupported(installedVersion.version)) {
        const venvInfo = await createProjectVenvWithPython(
          workingPath,
          installResult.pythonPath,
          [],
          sendLog
        );
        const versionResult = await getPythonVersionFromCommand(
          venvInfo.pythonPath
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
    return augmentStartupFailure(
      {
        success: false,
        code: "PYTHON_AUTO_SETUP_FAILED",
        error: `Automatic Python environment setup failed. Please install Python ${TARGET_PYTHON_VERSION} manually and create .venv in the backend project.`,
        manualGuide,
      },
      { stage: "prepare-project-python" }
    );
  } catch (error) {
    return toLoggedStartupFailure(error, {
      code:
        error.startupCode ||
        error.diagnostic?.code ||
        "PREPARE_PROJECT_PYTHON_FAILED",
      stage: "prepare-project-python",
      userMessage: error.userMessage || "Python runtime preparation failed.",
      recoveryHint: error.recoveryHint,
    });
  }
});

// IPC set project path
ipcMain.handle("set-project-path", async (event, selectPath) => {
  try {
    const normalizedPath = normalizeStoredBackendProjectPath(selectPath);
    const backendPathValidation = buildBackendPathValidationResult({
      backendProjectPath: normalizedPath,
      modelDir: globalConfig.general?.modelDir || "",
    });
    if (!backendPathValidation.valid) {
      return augmentStartupFailure(
        {
          success: false,
          code: backendPathValidation.code,
          error: backendPathValidation.message,
          recoveryHint: backendPathValidation.message,
          invalidPaths: backendPathValidation.invalidPaths,
        },
        { stage: "set-project-path" }
      );
    }

    const integrityResult = await ensurePackagedBackendIntegrity(normalizedPath);
    if (!integrityResult.success) {
      return augmentStartupFailure(integrityResult, {
        code: "PACKAGED_BACKEND_INTEGRITY_FAILED",
        stage: "set-project-path",
        userMessage: "Packaged backend integrity verification failed.",
      });
    }
    if (fs.existsSync(normalizedPath)) {
      global.projectPath = normalizedPath;
      return {
        success: true,
        path: normalizedPath,
        backendMode: isBundledBackendMode(normalizedPath) ? "bundled" : "external",
      };
    }
    return augmentStartupFailure(
      {
        success: false,
        code: "BACKEND_PROJECT_PATH_NOT_FOUND",
        error: "Backend project path does not exist.",
      },
      {
        stage: "set-project-path",
        recoveryHint: "Select an existing backend project directory.",
      }
    );
  } catch (error) {
    return toLoggedStartupFailure(error, {
      code: error.startupCode || error.diagnostic?.code || "SET_PROJECT_PATH_FAILED",
      stage: "set-project-path",
      userMessage: "Failed to set the backend project path.",
    });
  }
});
ipcMain.handle("check-venv", async () => {
  try {
    if (!global.projectPath) {
      return augmentStartupFailure(
        {
          success: false,
          code: "BACKEND_PROJECT_PATH_NOT_SET",
          error: "Backend project path is not set.",
        },
        {
          stage: "check-venv",
          recoveryHint: "Select the backend project directory first.",
        }
      );
    }

    if (isBundledBackendMode(global.projectPath)) {
      const bundledResult = await ensureBundledRuntimeReady();
      if (!bundledResult.success) {
        return augmentStartupFailure(bundledResult, { stage: "check-venv" });
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
      return augmentStartupFailure(integrityResult, {
        code: "PACKAGED_BACKEND_INTEGRITY_FAILED",
        stage: "check-venv",
      });
    }

    const venvInfo = await getUsableProjectVenvInfo(global.projectPath);
    if (!venvInfo.exists || !venvInfo.valid) {
      return augmentStartupFailure(
        {
          success: false,
          code: "PROJECT_VENV_UNUSABLE",
          exists: venvInfo.exists,
          valid: venvInfo.valid,
          venvPath: venvInfo.venvPath,
          venvName: venvInfo.venvName,
          error: venvInfo.error || "Project virtual environment is missing or invalid.",
        },
        {
          stage: "check-venv",
          recoveryHint: "Create or repair the project virtual environment, then retry.",
        }
      );
    }
    return {
      success: true,
      exists: true,
      valid: true,
      venvPath: venvInfo.venvPath,
      venvName: venvInfo.venvName,
    };
  } catch (error) {
    return toLoggedStartupFailure(error, {
      code: error.startupCode || error.diagnostic?.code || "PROJECT_VENV_CHECK_FAILED",
      stage: "check-venv",
      userMessage: "Failed to check the project virtual environment.",
    });
  }
});

// IPC handler - check project dependencies
ipcMain.handle("check-dependencies", async () => {
  try {
    if (!global.projectPath) {
      return augmentStartupFailure(
        {
          success: false,
          code: "BACKEND_PROJECT_PATH_NOT_SET",
          error: "Backend project path is not set.",
        },
        {
          stage: "check-dependencies",
          recoveryHint: "Select the backend project directory first.",
        }
      );
    }

    if (isBundledBackendMode(global.projectPath)) {
      const bundledResult = await ensureBundledRuntimeReady();
      if (!bundledResult.success) {
        return augmentStartupFailure(bundledResult, { stage: "check-dependencies" });
      }

      const dependencyResult = await probePythonDependencies(
        bundledResult.pythonPath,
        ["fastapi", "uvicorn", "numpy", "PIL", "torch", "transformers"],
        {
          cwd: bundledResult.path,
          timeout: 30000,
          env: getBundledRuntimeCommandEnv(),
        }
      );
      return createDependencyCheckResponse(dependencyResult, {
        code: "BUNDLED_DEPENDENCIES_UNUSABLE",
        stage: "check-dependencies",
      });
    }

    const integrityResult = await ensurePackagedBackendIntegrity(global.projectPath);
    if (!integrityResult.success) {
      return augmentStartupFailure(integrityResult, {
        code: "PACKAGED_BACKEND_INTEGRITY_FAILED",
        stage: "check-dependencies",
      });
    }

    const venvInfo = await getUsableProjectVenvInfo(global.projectPath);
    if (!venvInfo.exists || !venvInfo.valid) {
      return augmentStartupFailure(
        {
          success: false,
          code: "PROJECT_VENV_UNUSABLE",
          error: venvInfo.error || "Project virtual environment is missing or invalid.",
        },
        { stage: "check-dependencies" }
      );
    }

    const dependencyResult = await probePythonDependencies(
      venvInfo.pythonPath,
      ["fastapi", "uvicorn", "numpy", "PIL", "torch", "transformers"],
      {
        cwd: global.projectPath,
        timeout: 30000,
        env: getIsolatedPythonCommandEnv(venvInfo.venvPath),
      }
    );
    return createDependencyCheckResponse(dependencyResult, {
      code: "PYTHON_DEPENDENCIES_MISSING",
      stage: "check-dependencies",
    });
  } catch (error) {
    return toLoggedStartupFailure(error, {
      code: "PYTHON_DEPENDENCY_CHECK_FAILED",
      stage: "check-dependencies",
      userMessage: "Failed to check backend dependencies.",
    });
  }
});

// Helper - install the target Python runtime.
async function installTargetPython(sendLog, options = {}) {
  try {
    const platform = os.platform();
    if (platform !== "win32") {
      return augmentStartupFailure(
        {
          success: false,
          code: "PYTHON_AUTO_INSTALL_UNSUPPORTED",
          error: `Automatic installation is not supported on this platform. Please install Python ${TARGET_PYTHON_VERSION} manually.`,
        },
        {
          stage: "python-install",
          recoveryHint: `Install Python ${TARGET_PYTHON_VERSION} manually, then create .venv in the backend project.`,
        }
      );
    }
    const downloadUrl =
      "https://www.python.org/ftp/python/3.12.11/python-3.12.11-amd64.exe";

    const downloadDir = path.join(app.getPath("temp"), "moonshine-python-installer");
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }
    const fileName = path.basename(downloadUrl);
    const filePath = path.join(downloadDir, fileName);
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const installDir = path.join(localAppData, "Programs", "Python", "Python312");
    const installedPythonPath = path.join(installDir, "python.exe");

    sendLog?.(`Downloading Python installer: ${downloadUrl}`, "info");
    await withTrackedStartupOperation(
      (signal) =>
        downloadHttpsFile(downloadUrl, filePath, {
          ensureDiskSpace,
          getByteLength: getBufferByteLength,
          signal,
        }),
      options.signal
    );
    sendToMainWindow("python-install-path", filePath);

    sendLog?.("Python installer downloaded. Starting installation...", "info");
    await execFileCommand(
      filePath,
      [
        "/quiet",
        "InstallAllUsers=0",
        "PrependPath=0",
        "Include_launcher=1",
        "Include_test=0",
        `TargetDir=${installDir}`,
      ],
      {
        timeout: 600000,
        stage: "python-install",
        failureCode: "PYTHON_INSTALL_FAILED",
        userMessage: "Python installation failed.",
        signal: options.signal,
      }
    );

    fs.unlink(filePath, () => {});
    if (!fs.existsSync(installedPythonPath)) {
      throw new Error(`Python installation completed, but python.exe is missing: ${installedPythonPath}`);
    }
    const verification = await getPythonVersionFromCommand(installedPythonPath, [], {
      env: getCleanPythonCommandEnv(),
      stage: "python-install-verification",
      failureCode: "PYTHON_INSTALL_VERIFICATION_FAILED",
      userMessage: "Installed Python could not be verified.",
    });
    if (!verification.success || !isSupportedPythonVersion(verification.version)) {
      throw new Error(
        verification.error ||
          `Installed Python ${verification.version?.text || "unknown"} is not supported.`
      );
    }
    return {
      success: true,
      message: `Python ${TARGET_PYTHON_VERSION} installed successfully.`,
      pythonPath: installedPythonPath,
      pythonVersion: verification.version.text,
    };
  } catch (error) {
    return toLoggedStartupFailure(error, {
      code: "PYTHON_INSTALL_FAILED",
      stage: "python-install",
      userMessage: "Python installation failed.",
    });
  }
}

ipcMain.handle("install-python", async () => {
  return await installTargetPython();
});

// IPC create venv
ipcMain.handle("create-venv", async (event, projectPath) => {
  const sendLog = createBackendOutputSender(event.sender, "create-project-venv");

  try {
    const projectResult = await resolveValidatedProjectPath(
      projectPath || global.projectPath
    );
    if (!projectResult.success) {
      return augmentStartupFailure(projectResult, { stage: "create-project-venv" });
    }

    global.projectPath = projectResult.path;
    const workingPath = projectResult.path;
    if (isBundledBackendMode(workingPath)) {
      const bundledResult = await ensureBundledRuntimeReady(sendLog);
      if (!bundledResult.success) {
        return augmentStartupFailure(bundledResult, { stage: "create-project-venv" });
      }

      return {
        success: true,
        message: "Bundled offline runtime is already prepared.",
      };
    }

    const venvInfo = await getUsableProjectVenvInfo(workingPath);
    if (venvInfo.exists) {
      if (!venvInfo.valid) {
        return augmentStartupFailure(
          {
            success: false,
            code: "INVALID_PROJECT_VENV",
            error:
              venvInfo.error ||
              "A virtual environment folder exists in the backend project, but it is invalid. Please fix it manually.",
            manualGuide: buildManualVenvGuide(workingPath),
          },
          { stage: "create-project-venv" }
        );
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
      return augmentStartupFailure(
        {
          ...systemPython,
          manualGuide: buildManualVenvGuide(workingPath),
        },
        { stage: "create-project-venv" }
      );
    }

    if (!isSystemPythonVersionSupported(systemPython.version)) {
      return augmentStartupFailure(
        {
          success: false,
          code: "SYSTEM_PYTHON_UNSUPPORTED",
          error: `Detected system Python ${systemPython.version.text}. Please manually create a Python ${TARGET_PYTHON_VERSION} .venv.`,
          manualGuide: buildManualVenvGuide(workingPath),
        },
        { stage: "create-project-venv" }
      );
    }

    await createProjectVenvWithPython(
      workingPath,
      systemPython.command,
      systemPython.args || [],
      sendLog
    );
    return { success: true };
  } catch (error) {
    return toLoggedStartupFailure(error, {
      code: error.startupCode || error.diagnostic?.code || "PROJECT_VENV_CREATE_FAILED",
      stage: "create-project-venv",
      userMessage: "Failed to create the project virtual environment.",
    });
  }
});

// IPC create conda venv
ipcMain.handle("create-conda-venv", async (event) => {
  const sendLog = createBackendOutputSender(event.sender, "create-conda-environment");

  try {
    sendLog("Creating conda virtual environment...", "info");

    const environments = await getCondaEnvironmentList();

    if (!hasNamedCondaEnvironment(environments, "moonshine-image")) {
      sendLog("Creating moonshine-image conda environment...", "info");
      await execCondaCommand(
        ["create", "-n", "moonshine-image", `python=${TARGET_PYTHON_VERSION}`, "-y"],
        {
          timeout: 300000,
          stage: "create-conda-environment",
          failureCode: "CONDA_ENVIRONMENT_CREATE_FAILED",
          userMessage: "Failed to create the Conda environment.",
        }
      );
      sendLog("moonshine-image environment created successfully", "success");
    } else {
      sendLog("moonshine-image environment already exists", "success");
    }

    return { success: true };
  } catch (error) {
    sendLog(`Failed to create conda virtual environment: ${error.message}`, "error");
    return toLoggedStartupFailure(error, {
      code: "CONDA_ENVIRONMENT_CREATE_FAILED",
      stage: "create-conda-environment",
      userMessage: "Failed to create the Conda environment.",
    });
  }
});
// IPC handler - install dependencies
ipcMain.handle("install-dependencies", async (event, projectPath) => {
  const sendLog = createBackendOutputSender(event.sender, "install-dependencies");
  try {
    const projectResult = await resolveValidatedProjectPath(projectPath || global.projectPath);
    if (!projectResult.success) {
      return projectResult;
    }

    const workingPath = projectResult.path;
    if (isBundledBackendMode(workingPath)) {
      const bundledResult = await ensureBundledRuntimeReady(sendLog);
      if (!bundledResult.success) {
        return bundledResult;
      }

      sendLog("Bundled offline runtime already includes backend dependencies.", "success");
      return {
        success: true,
        message: "Bundled offline runtime already includes backend dependencies.",
      };
    }

    const venvInfo = await getUsableProjectVenvInfo(workingPath);
    if (!venvInfo.exists || !venvInfo.valid) {
      return augmentStartupFailure(
        {
          success: false,
          code: "PROJECT_VENV_UNUSABLE",
          error:
            venvInfo.error ||
            "Project virtual environment is missing or invalid. Create or repair .venv first.",
        },
        { stage: "install-dependencies" }
      );
    }

    sendLog("Starting dependency installation...", "info");
    await runProcess(
      venvInfo.pythonPath,
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
        env: getIsolatedPythonCommandEnv(venvInfo.venvPath),
        timeout: 1800000,
        stage: "install-dependencies",
        failureCode: "PYTHON_DEPENDENCY_INSTALL_FAILED",
        errorMessage: "Backend dependency installation failed.",
        recoveryHint: "Check the network, disk space, and the final pip output, then retry.",
        onStdout: (text) => sendLog(text, "info", { stream: "stdout" }),
        onStderr: (text) => sendLog(text, "warning", { stream: "stderr" }),
      }
    );
    sendLog("Dependencies installed successfully", "success");
    return { success: true, message: "Dependencies installed successfully" };
  } catch (error) {
    const failure = toLoggedStartupFailure(error, {
      code: "PYTHON_DEPENDENCY_INSTALL_FAILED",
      stage: "install-dependencies",
      userMessage: "Backend dependency installation failed.",
    });
    sendLog(failure.error, "error", {
      diagnostic: failure.diagnostic,
      diagnosticId: failure.diagnostic.id,
      recoveryHint: failure.recoveryHint,
    });
    return failure;
  }
});
// IPC handler - install conda dependencies
ipcMain.handle("install-conda-dependencies", async (event) => {
  const sendLog = createBackendOutputSender(event.sender, "install-conda-dependencies");

  try {
    if (!global.projectPath) {
      return { success: false, error: "Project path is not set." };
    }

    sendLog("Starting conda dependency installation...", "info");

    await execCondaCommand([
      "run",
      "-n",
      "moonshine-image",
      "python",
      "-m",
      "pip",
      "install",
      "-r",
      "requirements.txt",
      "-i",
      "https://pypi.tuna.tsinghua.edu.cn/simple",
    ], {
      cwd: global.projectPath,
      timeout: 1800000,
      stage: "install-conda-dependencies",
      failureCode: "CONDA_DEPENDENCY_INSTALL_FAILED",
      userMessage: "Conda dependency installation failed.",
      recoveryHint: "Check the Conda environment, network, disk space, and pip output.",
      onStdout: (text) => sendLog(text, "info", { stream: "stdout" }),
      onStderr: (text) => sendLog(text, "warning", { stream: "stderr" }),
    });
    sendLog("Conda dependencies installed successfully", "success");
    return { success: true };
  } catch (error) {
    const failure = toLoggedStartupFailure(error, {
      code: "CONDA_DEPENDENCY_INSTALL_FAILED",
      stage: "install-conda-dependencies",
      userMessage: "Conda dependency installation failed.",
    });
    sendLog(failure.error, "error", {
      diagnostic: failure.diagnostic,
      diagnosticId: failure.diagnostic.id,
      recoveryHint: failure.recoveryHint,
    });
    return failure;
  }
});
// IPC handler - start backend service
async function probePythonCudaCompatibility(
  pythonPath,
  runtimeEnv = process.env,
  options = {}
) {
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
    const probeResult = await execFileCommand(pythonPath, ["-c", probeScript], {
      env: runtimeEnv,
      timeout: 30000,
      stage: "cuda-preflight",
      failureCode: "CUDA_PREFLIGHT_FAILED",
      userMessage: "CUDA compatibility preflight failed.",
      signal: options.signal,
    });
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
      diagnostic: error.diagnostic,
    };
  }
}

async function launchBackendService(event, config, signal) {
  const sendLog = createBackendOutputSender(event.sender, "backend-start");
  try {
    let cancellation = getBackendStartCancellation(signal);
    if (cancellation) return cancellation;
    const currentStatus = backendSupervisor.getStatus();
    if (currentStatus.state === "running" || currentStatus.state === "starting") {
      return await backendSupervisor.start({});
    }
    if (currentStatus.state === "stopping" || currentStatus.processRunning) {
      const stopResult = await backendSupervisor.stop();
      if (!stopResult.success) return stopResult;
    }
    cancellation = getBackendStartCancellation(signal);
    if (cancellation) return cancellation;

    if (!global.projectPath) {
      return augmentStartupFailure(
        {
          success: false,
          code: "BACKEND_PROJECT_PATH_NOT_SET",
          error: "Project path is not set.",
        },
        { stage: "backend-preflight" }
      );
    }

    const launchConfig = config || {};
    const backendPathValidation = buildBackendPathValidationResult({
      backendProjectPath: global.projectPath,
      modelDir: launchConfig.modelDir || "",
    });
    if (!backendPathValidation.valid) {
      return augmentStartupFailure(
        {
          success: false,
          error: backendPathValidation.message,
          code: backendPathValidation.code,
          recoveryHint: backendPathValidation.message,
          invalidPaths: backendPathValidation.invalidPaths,
        },
        { stage: "backend-preflight" }
      );
    }

    const integrityResult = await ensurePackagedBackendIntegrity(global.projectPath);
    cancellation = getBackendStartCancellation(signal);
    if (cancellation) return cancellation;
    if (!integrityResult.success) {
      return augmentStartupFailure(integrityResult, {
        code: "PACKAGED_BACKEND_INTEGRITY_FAILED",
        stage: "backend-integrity",
        userMessage: "Packaged backend integrity verification failed.",
      });
    }

    const projectResult = await resolveValidatedProjectPath(global.projectPath);
    cancellation = getBackendStartCancellation(signal);
    if (cancellation) return cancellation;
    if (!projectResult.success) {
      return augmentStartupFailure(projectResult, { stage: "backend-preflight" });
    }

    global.projectPath = projectResult.path;
    let backendPython = "";
    let backendEnv = getCleanPythonCommandEnv();
    const portResolution = await resolveAvailableBackendPort(launchConfig.port);
    cancellation = getBackendStartCancellation(signal);
    if (cancellation) return cancellation;
    if (!portResolution.success) {
      return augmentStartupFailure(
        {
          success: false,
          code: "BACKEND_PORT_UNAVAILABLE",
          error: portResolution.error,
          requestedPort: portResolution.requestedPort,
          attemptedPorts: portResolution.attemptedPorts,
        },
        { stage: "backend-port-selection" }
      );
    }

    if (portResolution.portChanged) {
      sendLog(
        `配置端口 ${portResolution.requestedPort} 已被占用，` +
          `已自动切换到可用端口 ${portResolution.port}。`,
        "warning"
      );
    }

    const args = [
      "main.py",
      "start",
      `--model=${launchConfig.model}`,
      `--device=${launchConfig.device}`,
      `--port=${portResolution.port}`,
    ];
    args.push(
      launchConfig.samReleaseBeforeProcessing === false
        ? "--no-sam-release-before-processing"
        : "--sam-release-before-processing"
    );

    if (isBundledBackendMode(global.projectPath)) {
      const bundledResult = await ensureBundledRuntimeReady(sendLog, { signal });
      cancellation = getBackendStartCancellation(signal);
      if (cancellation) return cancellation;
      if (!bundledResult.success) {
        return augmentStartupFailure(bundledResult, {
          code: bundledResult.code || "BUNDLED_RUNTIME_UNUSABLE",
          stage: "bundled-runtime-preparation",
        });
      }

      const effectiveModelDir = resolveEffectiveModelDir({
        modelDir: launchConfig.modelDir || "",
      });
      backendPython = bundledResult.pythonPath;
      backendEnv = getUtf8ProcessEnv(
        getBundledRuntimeCommandEnv({
          TORCH_HOME: effectiveModelDir,
          XDG_CACHE_HOME: effectiveModelDir,
          U2NET_HOME: effectiveModelDir,
          HF_HOME: path.join(effectiveModelDir, "huggingface"),
        })
      );
      args.push(`--model-dir=${effectiveModelDir}`);
    } else {
      const venvInfo = await getUsableProjectVenvInfo(global.projectPath, { signal });
      cancellation = getBackendStartCancellation(signal);
      if (cancellation) return cancellation;
      if (!venvInfo.exists || !venvInfo.valid) {
        return augmentStartupFailure(
          {
            success: false,
            code: "PROJECT_VENV_UNUSABLE",
            error:
              venvInfo.error ||
              "Project virtual environment is missing or invalid. Create or repair .venv first.",
          },
          { stage: "backend-runtime-selection" }
        );
      }

      backendPython = venvInfo.pythonPath;
      backendEnv = getIsolatedPythonCommandEnv(venvInfo.venvPath);
      if (launchConfig.modelDir) {
        args.push(`--model-dir=${launchConfig.modelDir}`);
      }
    }

    if (launchConfig.device === "cuda") {
      const cudaProbe = await probePythonCudaCompatibility(backendPython, backendEnv, {
        signal,
      });
      cancellation = getBackendStartCancellation(signal);
      if (cancellation) return cancellation;
      if (!cudaProbe.success) {
        sendLog(
          `CUDA 预检失败，将继续尝试启动后端: ${cudaProbe.message || "未知错误"}`,
          "warning",
          {
            diagnostic: cudaProbe.diagnostic,
            diagnosticId: cudaProbe.diagnostic?.id,
          }
        );
      } else if (!cudaProbe.cuda_available) {
        return augmentStartupFailure(
          {
            success: false,
            code: "CUDA_NOT_AVAILABLE",
            error: "当前运行时未检测到可用 CUDA 设备，请切换为 CPU 模式后再启动后端。",
            cudaProbe,
          },
          { stage: "cuda-preflight" }
        );
      } else if (cudaProbe.cuda_compatible === false) {
        const capability = Array.isArray(cudaProbe.device_capability)
          ? `sm_${cudaProbe.device_capability.join("")}`
          : "unknown";
        return augmentStartupFailure(
          {
            success: false,
            code: "CUDA_RUNTIME_INCOMPATIBLE",
            error:
              `当前运行时的 PyTorch (${cudaProbe.torch_version || "unknown"}, CUDA ${cudaProbe.cuda_version || "unknown"}) ` +
              `不支持显卡 ${cudaProbe.device_name || ""} (${capability})。` +
              "请将启动方式切换为 CPU，或升级运行时到支持 CUDA 12.8/13.0 的 PyTorch。",
            cudaProbe,
          },
          { stage: "cuda-preflight" }
        );
      }
    }

    cancellation = getBackendStartCancellation(signal);
    if (cancellation) return cancellation;
    const startResult = await backendSupervisor.start({
      command: backendPython,
      args,
      cwd: global.projectPath,
      env: backendEnv,
      port: portResolution.port,
      requestedPort: portResolution.requestedPort,
      spawnOptions: {
        windowsHide: true,
        detached: process.platform !== "win32",
      },
    });
    return {
      ...startResult,
      requestedPort: portResolution.requestedPort,
      portChanged: portResolution.portChanged,
      attemptedPorts: portResolution.attemptedPorts,
    };
  } catch (error) {
    const cancellation = getBackendStartCancellation(signal);
    if (cancellation) return cancellation;
    return toLoggedStartupFailure(error, {
      code: error.startupCode || "BACKEND_START_FAILED",
      stage: "backend-start",
      userMessage: error.userMessage || "Backend service failed to start.",
      recoveryHint: error.recoveryHint,
    });
  }
}

ipcMain.handle("start-backend-service", async (event, config) => {
  if (applicationQuitRequested) return createBackendStartCancellation();
  if (backendStopPromise) {
    const stopResult = await backendStopPromise;
    if (!stopResult.success) return stopResult;
    if (applicationQuitRequested) return createBackendStartCancellation();
  }
  if (backendLaunchPromise) return await backendLaunchPromise;
  if (startupOperationRegistry.size > 0) {
    const settlement = await waitForActiveStartupOperations();
    if (!settlement.settled) {
      return augmentStartupFailure(
        {
          success: false,
          code: "STARTUP_OPERATIONS_STILL_RUNNING",
          error: "A previous startup operation is still shutting down.",
          pendingStartupOperations: settlement.pending,
        },
        {
          stage: "backend-preflight",
          recoveryHint: "Wait for the current setup operation to finish, then retry.",
        }
      );
    }
    if (applicationQuitRequested) return createBackendStartCancellation();
    if (backendLaunchPromise) return await backendLaunchPromise;
  }

  const abortController = new AbortController();
  backendLaunchAbortController = abortController;
  const pending = Promise.resolve().then(() =>
    launchBackendService(event, config, abortController.signal)
  );
  backendLaunchPromise = pending;
  try {
    return await pending;
  } finally {
    if (backendLaunchPromise === pending) backendLaunchPromise = null;
    if (backendLaunchAbortController === abortController) {
      backendLaunchAbortController = null;
    }
  }
});

// IPC handler - stop backend service
ipcMain.handle("stop-backend-service", async () => {
  if (backendStopPromise) return await backendStopPromise;
  const pending = Promise.resolve().then(async () => {
    try {
      return await stopBackendServiceAndPendingLaunch("Backend stop was requested.");
    } catch (error) {
      return toLoggedStartupFailure(error, {
        code: "BACKEND_STOP_FAILED",
        stage: "backend-stop",
        userMessage: "Backend service could not be stopped.",
      });
    }
  });
  backendStopPromise = pending;
  try {
    return await pending;
  } finally {
    if (backendStopPromise === pending) backendStopPromise = null;
  }
});

ipcMain.handle("check-backend-status", async () => backendSupervisor.getStatus());

ipcMain.handle("open-startup-log", async () => {
  try {
    await startupLogger.info("Startup log opened by the user.");
    await startupLogger.flush();
    const openError = await shell.openPath(STARTUP_LOG_PATH);
    if (openError) throw new Error(openError);
    return { success: true, logPath: STARTUP_LOG_PATH };
  } catch (error) {
    return toLoggedStartupFailure(error, {
      code: "STARTUP_LOG_OPEN_FAILED",
      stage: "open-startup-log",
      userMessage: "Could not open the startup log.",
      recoveryHint: `Open this file manually: ${STARTUP_LOG_PATH}`,
    });
  }
});
// IPC handler - execute command
ipcMain.handle("execute-command", async (event, { command, cwd }) => {
  try {
    const { stdout, stderr } = await execCommand(command, {
      cwd: cwd || global.projectPath,
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
    return toLoggedStartupFailure(error, {
      code: "PROJECT_VENV_CREATE_FAILED",
      stage: "create-project-venv",
      userMessage: "Failed to create the project virtual environment.",
    });
  }
});

const buildFileStatsPayload = (filePath) => {
  if (!fs.existsSync(filePath)) {
    return { success: false, error: `File does not exist: ${filePath}`, path: filePath };
  }

  const normalizedPath = path.normalize(filePath);
  const stats = fs.statSync(normalizedPath);
  return {
    success: true,
    path: normalizedPath,
    normalizedPath,
    data: {
      size: stats.size,
      name: path.basename(normalizedPath),
      lastModified: stats.mtime.getTime(),
      type: getMimeType(normalizedPath),
      path: normalizedPath,
      normalizedPath,
    },
  };
};

const IMAGE_FILE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]);

function listImageFilesInDirectory(rootPath, options = {}) {
  const root = path.normalize(String(rootPath || ""));
  const recursive = options.recursive !== false;
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Directory does not exist: ${rootPath}`);
  }

  const result = [];
  const visit = (directory) => {
    fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (recursive) {
          visit(entryPath);
        }
        return;
      }
      if (!entry.isFile() || !IMAGE_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        return;
      }

      const payload = buildFileStatsPayload(entryPath);
      if (!payload.success) {
        return;
      }
      result.push({
        ...payload.data,
        path: payload.path,
        normalizedPath: payload.normalizedPath,
        relativePath: path.relative(root, payload.normalizedPath),
      });
    });
  };

  visit(root);
  return result.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

// IPC handler - get file stats
ipcMain.handle("get-file-stats", async (event, filePath) => {
  try {
    return buildFileStatsPayload(filePath);
  } catch (error) {
    console.error("Failed to get file stats:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("get-files-stats", async (event, filePaths = []) => {
  try {
    const paths = Array.isArray(filePaths) ? filePaths : [];
    return {
      success: true,
      data: paths.map((filePath) => {
        try {
          return buildFileStatsPayload(filePath);
        } catch (error) {
          return {
            success: false,
            path: filePath,
            error: error.message,
          };
        }
      }),
    };
  } catch (error) {
    console.error("Failed to get batch file stats:", error);
    return { success: false, error: error.message, data: [] };
  }
});

ipcMain.handle("list-image-files", async (event, { folderPath, recursive = true } = {}) => {
  try {
    return {
      success: true,
      data: listImageFilesInDirectory(folderPath, { recursive }),
    };
  } catch (error) {
    console.error("Failed to list image files:", error);
    return { success: false, error: error.message, data: [] };
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
    const tempDir = path.join(
      globalConfig.fileManagement?.tempPath || createRuntimeDefaultConfig().fileManagement.tempPath,
      "moonshine-videos"
    );
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const tempPath = path.join(tempDir, `${Date.now()}_${fileName}`);
    const fileBuffer = Buffer.from(buffer);
    ensureDiskSpace(tempPath, {
      requiredBytes: fileBuffer.byteLength,
      operation: "保存临时视频",
    });
    fs.writeFileSync(tempPath, fileBuffer);

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

function normalizeTempCleanupOptions(options = {}, fallback = globalConfig.fileManagement?.tempCleanup) {
  const source = isPlainObject(options) && Object.keys(options).length > 0 ? options : fallback || {};
  return {
    enabled: normalizeBoolean(source.enabled, DEFAULT_TEMP_CLEANUP.enabled),
    onStartup: normalizeBoolean(source.onStartup, DEFAULT_TEMP_CLEANUP.onStartup),
    maxAgeDays: normalizeInteger(source.maxAgeDays, DEFAULT_TEMP_CLEANUP.maxAgeDays, 1, 365),
    includeImages: normalizeBoolean(source.includeImages, DEFAULT_TEMP_CLEANUP.includeImages),
    includeVideos: normalizeBoolean(source.includeVideos, DEFAULT_TEMP_CLEANUP.includeVideos),
    keepRecentFailures: normalizeBoolean(
      source.keepRecentFailures,
      DEFAULT_TEMP_CLEANUP.keepRecentFailures
    ),
  };
}

function buildTempCleanupTargets(tempRoot, cleanupOptions = {}) {
  const targets = [];
  if (cleanupOptions.includeImages) {
    targets.push(globalConfig.fileManagement?.imageFolderName || "images");
  }
  if (cleanupOptions.includeVideos) {
    targets.push(
      globalConfig.fileManagement?.videoFolderName || "videos",
      "video_frames",
      "moonshine-videos",
      "moonshine-sam-video-masks"
    );
  }

  return Array.from(new Set(targets.map((name) => String(name || "").trim()).filter(Boolean))).map(
    (name) => path.join(tempRoot, name)
  );
}

function shouldRemoveTempEntry(entryPath, cutoffMs, stats = null) {
  if (!fs.existsSync(entryPath)) {
    return false;
  }
  const entryStats = stats || fs.statSync(entryPath);
  return Number(entryStats.mtimeMs || 0) < cutoffMs;
}

function cleanupManagedTempDirectory({ directory, tempRoot, cutoffMs }) {
  const result = {
    removedFileCount: 0,
    removedDirectoryCount: 0,
    removedBytes: 0,
    skippedCount: 0,
  };

  if (!fs.existsSync(directory)) {
    return result;
  }
  if (!isPathInsideDirectory(directory, tempRoot)) {
    throw new Error(`Refusing to clean outside temp path: ${directory}`);
  }

  const stats = fs.statSync(directory);
  if (!stats.isDirectory()) {
    if (shouldRemoveTempEntry(directory, cutoffMs, stats)) {
      result.removedBytes += stats.size || 0;
      fs.rmSync(directory, { force: true });
      result.removedFileCount += 1;
    } else {
      result.skippedCount += 1;
    }
    return result;
  }

  fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (!isPathInsideDirectory(entryPath, tempRoot)) {
      result.skippedCount += 1;
      return;
    }
    const entryStats = fs.statSync(entryPath);
    if (!shouldRemoveTempEntry(entryPath, cutoffMs, entryStats)) {
      result.skippedCount += 1;
      return;
    }
    result.removedBytes += entryStats.size || 0;
    fs.rmSync(entryPath, { recursive: true, force: true });
    if (entryStats.isDirectory()) {
      result.removedDirectoryCount += 1;
    } else {
      result.removedFileCount += 1;
    }
  });

  return result;
}

function isVideoProcessingTaskNewerThanCutoff(task = {}, cutoffMs = Number.NaN) {
  if (!Number.isFinite(cutoffMs)) {
    return false;
  }

  const timestamps = [getVideoTaskTimestamp(task)];
  [task?.taskRoot, task?.temporarySourcePath].forEach((entryPath) => {
    if (typeof entryPath !== "string" || !entryPath || !fs.existsSync(entryPath)) {
      return;
    }
    try {
      timestamps.push(Number(fs.statSync(entryPath).mtimeMs || 0));
    } catch {
      // Missing or locked entries should not block cleanup of stale registry records.
    }
  });

  return Math.max(...timestamps) >= cutoffMs;
}

function cleanupVideoProcessingTempWithPolicy(cleanupOptions = {}, cutoffMs = Number.NaN) {
  if (!cleanupOptions.includeVideos) {
    return {
      removedTaskCount: 0,
      removedDirectoryCount: 0,
      removedTempSourceCount: 0,
      preservedTaskCount: 0,
      missingTaskCount: 0,
    };
  }

  const preserveTaskIds = cleanupOptions.keepRecentFailures
    ? getLatestFailedVideoTaskIds()
    : new Set();
  return cleanupVideoProcessingTempEntries({ preserveTaskIds, cutoffMs });
}

function cleanupAppTempFiles(options = {}) {
  const cleanupOptions = normalizeTempCleanupOptions(options);
  const tempRoot = path.normalize(
    String(globalConfig.fileManagement?.tempPath || createRuntimeDefaultConfig().fileManagement.tempPath)
  );
  if (!tempRoot || !fs.existsSync(tempRoot)) {
    return {
      success: true,
      data: {
        ...cleanupOptions,
        removedFileCount: 0,
        removedDirectoryCount: 0,
        removedTaskCount: 0,
        removedTempSourceCount: 0,
        removedBytes: 0,
        skippedCount: 0,
      },
    };
  }

  const cutoffMs = Date.now() - cleanupOptions.maxAgeDays * 24 * 60 * 60 * 1000;
  const aggregate = {
    removedFileCount: 0,
    removedDirectoryCount: 0,
    removedTaskCount: 0,
    removedTempSourceCount: 0,
    removedBytes: 0,
    skippedCount: 0,
  };

  buildTempCleanupTargets(tempRoot, cleanupOptions).forEach((directory) => {
    const result = cleanupManagedTempDirectory({ directory, tempRoot, cutoffMs });
    aggregate.removedFileCount += result.removedFileCount;
    aggregate.removedDirectoryCount += result.removedDirectoryCount;
    aggregate.removedBytes += result.removedBytes;
    aggregate.skippedCount += result.skippedCount;
  });

  const videoResult = cleanupVideoProcessingTempWithPolicy(cleanupOptions, cutoffMs);
  aggregate.removedTaskCount += Number(videoResult.removedTaskCount || 0);
  aggregate.removedDirectoryCount += Number(videoResult.removedDirectoryCount || 0);
  aggregate.removedTempSourceCount += Number(videoResult.removedTempSourceCount || 0);
  aggregate.skippedCount += Number(videoResult.preservedTaskCount || 0);

  return {
    success: true,
    data: {
      ...cleanupOptions,
      ...aggregate,
      tempPath: tempRoot,
    },
  };
}

function cleanupVideoProcessingTempEntries({
  preserveTaskIds = new Set(),
  cutoffMs = Number.NaN,
  pruneMissingTasks = true,
} = {}) {
  const normalizedPreserveTaskIds =
    preserveTaskIds instanceof Set ? preserveTaskIds : new Set(preserveTaskIds || []);
  const registry = readVideoProcessingRegistry();
  const tasks = Object.entries(registry.tasks || {});
  const nextTasks = {};
  let removedTaskCount = 0;
  let removedDirectoryCount = 0;
  let removedTempSourceCount = 0;
  let preservedTaskCount = 0;
  let missingTaskCount = 0;

  tasks.forEach(([taskId, task]) => {
    const preserveTask = normalizedPreserveTaskIds.has(taskId);
    const taskRoot = typeof task?.taskRoot === "string" ? task.taskRoot : "";
    const temporarySourcePath =
      typeof task?.temporarySourcePath === "string" ? task.temporarySourcePath : "";
    const hasTaskRoot = Boolean(taskRoot) && fs.existsSync(taskRoot);
    const hasTemporarySource = Boolean(temporarySourcePath) && fs.existsSync(temporarySourcePath);
    const isRecentTask = isVideoProcessingTaskNewerThanCutoff(task, cutoffMs);

    if (preserveTask || isRecentTask) {
      preservedTaskCount += 1;
      if (hasTaskRoot || hasTemporarySource) {
        nextTasks[taskId] = task;
      } else {
        missingTaskCount += 1;
        if (!pruneMissingTasks) {
          nextTasks[taskId] = task;
        }
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
      if (!pruneMissingTasks) {
        nextTasks[taskId] = task;
      }
    }
  });

  writeVideoProcessingRegistry({
    ...registry,
    tasks: nextTasks,
  });

  return {
    removedTaskCount,
    removedDirectoryCount,
    removedTempSourceCount,
    preservedTaskCount,
    missingTaskCount,
  };
}

function getActiveProcessingTaskSummary() {
  const tasks = Array.from(activeProcessingTasks.values());
  const imageCount = tasks.filter((task) => task.type === "image").length;
  const videoCount = tasks.filter((task) => task.type === "video").length;
  const labels = tasks
    .map((task) => String(task.label || "").trim())
    .filter(Boolean)
    .slice(0, 3);

  return {
    count: tasks.length,
    imageCount,
    videoCount,
    labels,
  };
}

function buildActiveProcessingCloseMessage() {
  const summary = getActiveProcessingTaskSummary();
  const parts = [];
  if (summary.imageCount > 0) {
    parts.push(`${summary.imageCount} 个图片任务`);
  }
  if (summary.videoCount > 0) {
    parts.push(`${summary.videoCount} 个视频任务`);
  }
  const taskText = parts.length > 0 ? parts.join("、") : `${summary.count} 个任务`;
  const labelText =
    summary.labels.length > 0 ? `\n\n当前任务：${summary.labels.join("，")}` : "";

  return `当前还有 ${taskText} 正在处理中。直接关闭会中断处理进程，可能导致当前结果丢失。${labelText}\n\n确定要关闭 Moonshine-Image 吗？`;
}

ipcMain.handle("cleanup-app-temp-files", async (event, options = {}) => {
  try {
    return cleanupAppTempFiles(options);
  } catch (error) {
    console.error("Failed to clean up app temp files:", error);
    return {
      success: false,
      error: error.message,
    };
  }
});

ipcMain.handle("cleanup-video-processing-temp", async (event, options = {}) => {
  try {
    const preserveTaskIds = new Set(
      Array.isArray(options?.preserveTaskIds)
        ? options.preserveTaskIds.filter((taskId) => typeof taskId === "string" && taskId.trim())
        : []
    );
    const latestFailedTaskIds = getLatestFailedVideoTaskIds();
    latestFailedTaskIds.forEach((taskId) => preserveTaskIds.add(taskId));
    const cleanupResult = cleanupVideoProcessingTempEntries({
      preserveTaskIds,
      pruneMissingTasks: false,
    });

    return {
      success: true,
      data: cleanupResult,
    };
  } catch (error) {
    console.error("Failed to clean up video processing temp directories:", error);
    return {
      success: false,
      error: error.message,
    };
  }
});
ipcMain.on("set-active-processing-task", (event, payload = {}) => {
  const taskId = String(payload?.taskId || "").trim();
  if (!taskId) {
    return;
  }

  if (payload.active === false) {
    activeProcessingTasks.delete(taskId);
    return;
  }

  activeProcessingTasks.set(taskId, {
    taskId,
    type: String(payload.type || "task"),
    label: String(payload.label || "处理中任务"),
    updatedAt: Date.now(),
  });
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

async function recordApplicationDiagnostic(code, stage, error, details = {}) {
  const diagnostic = createDiagnostic({
    code,
    stage,
    reason: error?.message || details.reason || code,
    error,
    osCode: details.osCode,
    exitCode: details.exitCode,
    signal: details.signal,
    logPath: STARTUP_LOG_PATH,
  });
  await startupLogger.error(error?.message || details.reason || code, {
    diagnostic,
    details,
  });
  return diagnostic;
}

async function handleRendererRuntimeFailure(windowInstance, error, options = {}) {
  const diagnostic = await recordApplicationDiagnostic(
    options.code || "APP_RENDERER_FAILED",
    options.stage || "renderer-runtime",
    error,
    options.details
  );
  if (options.initialLoad === true) {
    return await handleFatalStartupError(
      new ApplicationBootstrapError(error?.message || "Application window failed to load.", {
        code: options.code || "APP_WINDOW_LOAD_FAILED",
        phase: options.stage || "window-load",
        exitCode: 174,
        diagnostic,
        cause: error,
        recoveryHint: "Restart the application. If the problem continues, reinstall it.",
      })
    );
  }
  if (rendererFailureDialogOpen) return;
  rendererFailureDialogOpen = true;
  try {
    const result = await dialog.showMessageBox(windowInstance, {
      type: "error",
      buttons: ["重启应用", "退出"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: "应用界面发生错误",
      message: "应用界面已停止响应或意外退出。",
      detail:
        `错误代码: ${diagnostic.code}\n` +
        `诊断编号: ${diagnostic.id}\n` +
        `启动日志: ${STARTUP_LOG_PATH}`,
    });
    allowCloseWithActiveProcessingTasks = true;
    if (result.response === 0) app.relaunch();
    app.quit();
  } finally {
    rendererFailureDialogOpen = false;
  }
}

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
  const windowInstance = mainWindow;
  let initialLoadComplete = false;
  let initialLoadDiagnostic = null;
  let initialLoadDiagnosticPromise = null;

  windowInstance.webContents.on("preload-error", (event, preloadPath, error) => {
    void handleRendererRuntimeFailure(windowInstance, error, {
      code: "APP_PRELOAD_FAILED",
      stage: "preload",
      initialLoad: !initialLoadComplete,
      details: { preloadPath },
    });
  });
  windowInstance.webContents.on(
    "did-fail-load",
    (event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame) return;
      const error = new Error(errorDescription || `Window load failed (${errorCode}).`);
      if (initialLoadComplete) {
        void handleRendererRuntimeFailure(windowInstance, error, {
          code: "APP_WINDOW_LOAD_FAILED",
          stage: "window-load",
          details: { osCode: errorCode, validatedUrl },
        });
        return;
      }
      initialLoadDiagnosticPromise = recordApplicationDiagnostic(
        "APP_WINDOW_LOAD_FAILED",
        "window-load",
        error,
        {
        osCode: errorCode,
        validatedUrl,
        }
      );
      void initialLoadDiagnosticPromise.then((diagnostic) => {
        initialLoadDiagnostic = diagnostic;
      });
    }
  );
  windowInstance.webContents.on("render-process-gone", (event, details) => {
    if (details?.reason === "clean-exit") return;
    const error = new Error(`Renderer process exited: ${details?.reason || "unknown"}.`);
    void handleRendererRuntimeFailure(windowInstance, error, {
      code: "APP_RENDERER_PROCESS_GONE",
      stage: "renderer-runtime",
      initialLoad: !initialLoadComplete,
      details,
    });
  });
  windowInstance.on("unresponsive", () => {
    void handleRendererRuntimeFailure(
      windowInstance,
      new Error("Application window became unresponsive."),
      {
        code: "APP_WINDOW_UNRESPONSIVE",
        stage: "renderer-runtime",
        initialLoad: !initialLoadComplete,
      }
    );
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

  try {
    if (process.env.DEV) {
      await windowInstance.loadURL(process.env.APP_URL);
    } else {
      await windowInstance.loadFile("index.html");
    }
    initialLoadComplete = true;
  } catch (error) {
    const diagnostic =
      initialLoadDiagnostic ||
      (await initialLoadDiagnosticPromise) ||
      (await recordApplicationDiagnostic("APP_WINDOW_LOAD_FAILED", "window-load", error));
    throw new ApplicationBootstrapError(error?.message || "Application window failed to load.", {
      code: "APP_WINDOW_LOAD_FAILED",
      phase: "window-load",
      exitCode: 174,
      diagnostic,
      cause: error,
      recoveryHint: "Restart the application. If the problem continues, reinstall it.",
    });
  }

  if (process.env.DEBUGGING) {
    // if on DEV or Production with debug enabled
    windowInstance.webContents.openDevTools();
  } else {
    // we're on production; no access to devtools pls
    windowInstance.webContents.on("devtools-opened", () => {
      windowInstance.webContents.closeDevTools();
    });
  }

  windowInstance.on("close", (event) => {
    if (allowCloseWithActiveProcessingTasks || activeProcessingTasks.size === 0) {
      return;
    }

    const choice = dialog.showMessageBoxSync(windowInstance, {
      type: "warning",
      buttons: ["继续处理", "关闭应用"],
      defaultId: 0,
      cancelId: 0,
      title: "任务仍在处理中",
      message: "任务仍在处理中",
      detail: buildActiveProcessingCloseMessage(),
      noLink: true,
    });

    if (choice !== 1) {
      event.preventDefault();
      if (applicationQuitRequested) {
        applicationQuitRequested = false;
        quitAfterBackendStop = false;
        backendShutdownPromise = null;
      }
      return;
    }

    allowCloseWithActiveProcessingTasks = true;
  });

  windowInstance.on("closed", () => {
    if (mainWindow !== windowInstance) return;
    activeProcessingTasks.clear();
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

function registerSessionSecurity() {
  if (sessionSecurityRegistered) return;
  sessionSecurityRegistered = true;
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
}

async function registerApplicationInfrastructure() {
  registerAtomProtocol();
  registerSessionSecurity();
}

const handleFatalStartupError = createFatalStartupHandler(async (error) => {
    const source = error instanceof Error ? error : new Error(String(error));
    const failure = toStartupFailure(source, {
      code: source.code || "APP_BOOTSTRAP_FAILED",
      stage: source.phase || "app-bootstrap",
      userMessage: source.message || "Application startup failed.",
      recoveryHint: source.recoveryHint,
      diagnostic: source.diagnostic,
      logPath: STARTUP_LOG_PATH,
    });
    await startupLogger.error(failure.error, {
      recoveryHint: failure.recoveryHint,
      diagnostic: failure.diagnostic,
    });
    try {
      applicationQuitRequested = true;
      const stopResult = await stopBackendServiceAndPendingLaunch(
        "Application startup failed while startup operations were in progress."
      );
      if (!stopResult.success) {
        await startupLogger.error(stopResult.error || "Backend shutdown failed.", {
          recoveryHint: stopResult.recoveryHint,
          diagnostic: stopResult.diagnostic,
        });
      }
    } catch (stopError) {
      await startupLogger.error("Backend shutdown failed while handling a fatal error.", {
        reason: stopError?.message || String(stopError),
      });
    }
    await startupLogger.flush();

    try {
      dialog.showErrorBox(
        source instanceof ApplicationBootstrapError && source.exitCode === 173
          ? "应用资源完整性校验失败"
          : "应用启动失败",
        `${failure.error}\n\n` +
          `错误代码: ${failure.code}\n` +
          `诊断编号: ${failure.diagnostic.id}\n` +
          `处理建议: ${failure.recoveryHint}\n` +
          `启动日志: ${STARTUP_LOG_PATH}`
      );
    } catch (dialogError) {
      console.error("Failed to display fatal startup error:", dialogError);
    } finally {
      app.exit(source instanceof ApplicationBootstrapError ? source.exitCode : 174);
    }
    return failure;
});

process.on("uncaughtException", (error) => {
  void handleFatalStartupError(error);
});
process.on("unhandledRejection", (reason) => {
  void handleFatalStartupError(reason instanceof Error ? reason : new Error(String(reason)));
});

applicationBootstrapPromise = app
  .whenReady()
  .then(() =>
    bootstrapApplication({
      verifyIntegrity: verifyPackagedResourcesIntegrity,
      registerProtocol: registerApplicationInfrastructure,
      loadConfig: async () => loadAppConfig(),
      cleanupTemporaryFiles: async () => runStartupTempCleanup(),
      createWindow,
    })
  )
  .then((result) => {
    applicationBootstrapComplete = true;
    return result;
  })
  .catch(handleFatalStartupError);

app.on("before-quit", (event) => {
  if (quitAfterBackendStop) return;
  event.preventDefault();
  applicationQuitRequested = true;
  if (backendShutdownPromise) return;

  backendShutdownPromise = (async () => {
    try {
      const result = await stopBackendServiceAndPendingLaunch(
        "Application quit while backend startup was in progress."
      );
      if (!result.success) {
        await startupLogger.error(result.error || "Backend shutdown failed during app quit.", {
          recoveryHint: result.recoveryHint,
          diagnostic: result.diagnostic,
        });
      }
    } catch (error) {
      const failure = toStartupFailure(error, {
        code: "BACKEND_STOP_FAILED",
        stage: "application-quit",
        userMessage: "Backend shutdown failed during app quit.",
        logPath: STARTUP_LOG_PATH,
      });
      await startupLogger.error(failure.error, { diagnostic: failure.diagnostic });
    } finally {
      await startupLogger.flush();
      quitAfterBackendStop = true;
      app.quit();
    }
  })();
});

app.on("window-all-closed", () => {
  if (platform !== "darwin") app.quit();
});

app.on("activate", () => {
  void (async () => {
    await applicationBootstrapPromise;
    if (
      !applicationBootstrapComplete ||
      applicationQuitRequested ||
      BrowserWindow.getAllWindows().length > 0
    ) {
      return;
    }
    await createWindow();
  })().catch(handleFatalStartupError);
});
