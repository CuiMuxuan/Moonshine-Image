import fs from "node:fs/promises";
import path from "node:path";

import { EnvironmentBootstrap } from "./environment-bootstrap.js";
import { DEFAULT_MINIMUM_DRIVER_MAJOR } from "./environment-detector.js";
import { ExternalEnvironmentService } from "./external-environment.js";
import {
  ACCELERATOR_PREFERENCES,
  normalizeAcceleratorPreference,
} from "./environment-spec.js";

const PREFERENCE_FILE = "preference.json";
const PREFERENCE_SCHEMA = 2;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeError(error, fallbackCode = "ENVIRONMENT_MANAGER_FAILED") {
  return {
    message: error?.message || String(error),
    code: error?.code || fallbackCode,
    details: clone(error?.details || {}),
  };
}

function createPreparationCancellation() {
  const error = new Error("运行环境准备已取消。");
  error.name = "AbortError";
  error.code = "ENVIRONMENT_PREPARATION_CANCELLED";
  return error;
}

function preparationOperationId() {
  return `environment-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export const ENVIRONMENT_STATUS = Object.freeze({
  DISABLED: "disabled",
  IDLE: "idle",
  CHECKING: "checking",
  READY: "ready",
  DEGRADED: "degraded",
  NEEDS_CREATE: "needs-create",
  NEEDS_REPAIR: "needs-repair",
  PREPARING: "preparing",
  CANCELLING: "cancelling",
  VERIFYING: "verifying",
  FAILED: "failed",
  ROLLING_BACK: "rolling-back",
});

const ENVIRONMENT_UPDATE_READY_STATUSES = Object.freeze([
  ENVIRONMENT_STATUS.READY,
  ENVIRONMENT_STATUS.DEGRADED,
]);

export class EnvironmentManager {
  constructor({
    userData,
    appVersion,
    backendProjectPath,
    requirementsPath,
    requirementsPaths = {},
    requirementsLockPaths = requirementsPaths,
    requirementsLockHashes = {},
    requirementsLockPath = requirementsPath,
    ffmpegSourcePath,
    offlinePayloadRoot,
    offlinePayloadRoots = [],
    offlinePayloadLocationPath,
    modelRoot,
    pythonInstaller,
    commandRunner,
    acceleratorRunner,
    sourceConfig = {},
    probe,
    detector,
    publicKeys = {},
    expectedKeyId,
    requireSignedPayload = false,
    canActivate,
    onState,
    enabled = true,
    minimumDriverMajor,
    externalEnvironment,
    externalConfigPath,
    externalCandidateTtlMs,
    externalProbeTimeoutMs,
    externalFs,
    externalNow,
    randomUUID,
  } = {}) {
    this.userData = path.resolve(String(userData || process.cwd()));
    this.rootDir = this.userData;
    this.backendProjectPath = backendProjectPath ? path.resolve(backendProjectPath) : "";
    this.ffmpegSourcePath = ffmpegSourcePath ? path.resolve(ffmpegSourcePath) : "";
    this.offlinePayloadRoot = offlinePayloadRoot ? path.resolve(offlinePayloadRoot) : "";
    this.offlinePayloadRoots = [
      this.offlinePayloadRoot,
      ...offlinePayloadRoots.map((value) => path.resolve(String(value))),
    ].filter(Boolean);
    this.offlinePayloadLocationPath = offlinePayloadLocationPath
      ? path.resolve(offlinePayloadLocationPath)
      : "";
    this.modelRoot = modelRoot ? path.resolve(modelRoot) : "";
    this.preferencePath = path.join(this.userData, "environments", PREFERENCE_FILE);
    this.onState = typeof onState === "function" ? onState : () => {};
    this.canActivate = typeof canActivate === "function" ? canActivate : async () => true;
    this.enabled = Boolean(enabled);
    this.preference = "auto";
    this.preferenceExplicit = false;
    this.active = null;
    this.source = "managed";
    this.externalActive = null;
    this.diagnostics = null;
    this.activePreparation = null;
    this.minimumDriverMajor = Number.isFinite(Number(minimumDriverMajor))
      ? Number(minimumDriverMajor)
      : DEFAULT_MINIMUM_DRIVER_MAJOR;
    this.state = {
      enabled: this.enabled,
      status: this.enabled ? ENVIRONMENT_STATUS.IDLE : ENVIRONMENT_STATUS.DISABLED,
      source: this.source,
      preference: this.preference,
      preferenceExplicit: this.preferenceExplicit,
      selectedAccelerator: null,
      detectedAccelerator: null,
      reason: null,
      activePath: null,
      specHash: null,
      pythonVersion: null,
      torchVersion: null,
      cudaVersion: null,
      cudaAvailable: null,
      ffmpegVersion: null,
      ffmpegPath: this.ffmpegSourcePath || null,
      videoAvailable: null,
      diagnostics: null,
      error: null,
      progress: null,
      operationId: null,
      canCancel: false,
      targetPath: null,
      recoveredStagingCount: 0,
      restartRequired: false,
      externalConfigured: false,
      externalPath: null,
      externalLayout: null,
      externalFingerprint: null,
      externalLastVerifiedAt: null,
      externalCandidateToken: null,
      externalCandidateExpiresAt: null,
      nvidiaDeviceName: null,
      nvidiaDriverVersion: null,
      canSwitchToCu130: false,
      canSwitchToCpu: false,
      acceleratorChangeReason: null,
    };

    this.bootstrap = new EnvironmentBootstrap({
      rootDir: this.rootDir,
      appVersion,
      requirementsPath,
      requirementsPaths,
      requirementsLockPaths,
      requirementsLockHashes,
      requirementsLockPath,
      ffmpegSourcePath,
      pythonInstaller,
      commandRunner,
      acceleratorRunner,
      sourceConfig,
      probe,
      detector,
      minimumDriverMajor: this.minimumDriverMajor,
      publicKeys,
      expectedKeyId,
      requireSignedPayload,
    });
    this.externalEnvironment = externalEnvironment || new ExternalEnvironmentService({
      userData: this.userData,
      configPath: externalConfigPath,
      backendProjectPath: this.backendProjectPath,
      ffmpegPath: ffmpegSourcePath,
      runner: commandRunner,
      fsImpl: externalFs,
      now: externalNow,
      randomUUID,
      candidateTtlMs: externalCandidateTtlMs,
      probeTimeoutMs: externalProbeTimeoutMs,
    });
  }

  getState() {
    return clone(this.state);
  }

  _emit(patch = {}) {
    this.state = { ...this.state, ...patch };
    try {
      this.onState(this.getState());
    } catch {
      // Renderer observers must not affect environment activation.
    }
    return this.getState();
  }

  async _readPreference() {
    try {
      const value = JSON.parse(await fs.readFile(this.preferencePath, "utf8"));
      const storedPreference = normalizeAcceleratorPreference(value.preference);
      const hasExplicitMetadata = value.schema === PREFERENCE_SCHEMA && value.explicit === true;
      // Older builds could persist CPU while merely displaying an automatic fallback.
      // Preserve legacy cu130 selections, but migrate ambiguous CPU values back to auto.
      this.preferenceExplicit = hasExplicitMetadata || (!value.schema && storedPreference === "cu130");
      this.preference = this.preferenceExplicit ? storedPreference : "auto";
    } catch {
      this.preference = "auto";
      this.preferenceExplicit = false;
    }
    this._emit({
      preference: this.preference,
      preferenceExplicit: this.preferenceExplicit,
    });
  }

  async _writePreference() {
    await fs.mkdir(path.dirname(this.preferencePath), { recursive: true });
    const temporary = `${this.preferencePath}.tmp-${process.pid}`;
    await fs.writeFile(temporary, `${JSON.stringify({
      schema: PREFERENCE_SCHEMA,
      preference: this.preference,
      explicit: this.preferenceExplicit,
    }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temporary, this.preferencePath).catch(async (error) => {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    });
  }

  async _resolveOfflinePayloadRoot() {
    const candidates = [...this.offlinePayloadRoots];
    if (this.offlinePayloadLocationPath) {
      try {
        const location = (await fs.readFile(this.offlinePayloadLocationPath, "utf8")).trim();
        if (location) candidates.unshift(location);
      } catch (error) {
        if (error?.code !== "ENOENT") return null;
      }
    }
    const envRoot = String(process.env.MOONSHINE_OFFLINE_PAYLOAD_ROOT || "").trim();
    if (envRoot) candidates.unshift(envRoot);
    candidates.push(
      path.join(process.cwd(), "offline-payload"),
      path.join(path.dirname(process.execPath), "offline-payload"),
      path.join(path.dirname(process.execPath), "..", "offline-payload"),
    );
    const seen = new Set();
    for (const candidate of candidates) {
      const root = path.resolve(String(candidate));
      if (seen.has(root)) continue;
      seen.add(root);
      try {
        const manifestPath = path.join(root, "payload-manifest.json");
        await fs.access(manifestPath);
        return root;
      } catch {
        // Continue looking for a sibling payload.
      }
    }
    return null;
  }

  async _copyMissingModelFiles(sourceRoot) {
    if (!sourceRoot || !this.modelRoot) return;
    const source = path.resolve(sourceRoot);
    const destination = path.resolve(this.modelRoot);
    const visit = async (current, relative = "") => {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const sourcePath = path.join(current, entry.name);
        const relativePath = path.join(relative, entry.name);
        const destinationPath = path.join(destination, relativePath);
        if (entry.isDirectory()) {
          await visit(sourcePath, relativePath);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          await fs.access(destinationPath);
          continue;
        } catch {
          await fs.mkdir(path.dirname(destinationPath), { recursive: true });
          await fs.copyFile(sourcePath, destinationPath);
        }
      }
    };
    await visit(source);
  }

  _applyActive(active, patch = {}) {
    this.active = active || null;
    this.source = "managed";
    const selectedAccelerator = active?.accelerator || patch.selectedAccelerator || null;
    return this._emit({
      ...patch,
      source: this.source,
      activePath: active?.absolutePath || null,
      specHash: active?.specHash || patch.specHash || null,
      selectedAccelerator,
      detectedAccelerator: selectedAccelerator,
    });
  }

  _applyExternal(result, patch = {}) {
    this.source = "external";
    this.externalActive = result?.environment || null;
    const environment = this.externalActive;
    return this._emit({
      ...patch,
      source: this.source,
      status: patch.status || ENVIRONMENT_STATUS.READY,
      activePath: environment?.normalizedPath || patch.activePath || null,
      specHash: null,
      selectedAccelerator: environment?.accelerator || null,
      detectedAccelerator: environment?.accelerator || null,
      externalConfigured: true,
      externalPath: environment?.normalizedPath || result?.config?.environment?.normalizedPath || patch.externalPath || null,
      externalLayout: environment?.layout || result?.config?.environment?.layout || patch.externalLayout || null,
      externalFingerprint: environment?.fingerprint || result?.config?.environment?.fingerprint || patch.externalFingerprint || null,
      externalLastVerifiedAt: result?.config?.environment?.lastVerifiedAt || result?.config?.lastVerifiedAt || patch.externalLastVerifiedAt || null,
      externalCandidateToken: null,
      externalCandidateExpiresAt: null,
    });
  }

  _resetExternalState(patch = {}) {
    this.externalActive = null;
    return this._emit({
      ...patch,
      externalConfigured: false,
      externalPath: null,
      externalLayout: null,
      externalFingerprint: null,
      externalLastVerifiedAt: null,
      externalCandidateToken: null,
      externalCandidateExpiresAt: null,
    });
  }

  _activePythonExecutable(activePath = this.active?.absolutePath || this.state.activePath) {
    if (!activePath) return null;
    const relative = this.active?.pythonExecutableRelative;
    const normalized = typeof relative === "string" ? relative.replace(/\\/g, "/") : "";
    const safe = normalized && !path.isAbsolute(relative) && !/^[A-Za-z]:[\\/]/.test(relative)
      && !normalized.startsWith("/") && !normalized.split("/").some((part) => !part || part === "." || part === ".." || part === ".staging");
    if (safe) {
      return path.resolve(activePath, this.active.pythonExecutableRelative);
    }
    return path.join(activePath, "venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
  }

  _activeFfmpegPath(activePath = this.active?.absolutePath || this.state.activePath) {
    if (this.ffmpegSourcePath) return this.ffmpegSourcePath;
    if (!activePath) return null;
    if (this.active?.ffmpegRelative) return path.resolve(activePath, this.active.ffmpegRelative);
    return path.join(activePath, "ffmpeg", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  }

  async initialize() {
    if (!this.enabled) return this.getState();
    const recovery = await this.bootstrap.cleanupStaleStaging().catch(() => ({ count: 0 }));
    this._emit({ recoveredStagingCount: Number(recovery?.count) || 0 });
    await this._readPreference();
    this.active = await this.bootstrap.getActive();
    const external = await this.externalEnvironment.reprobeConfigured();
    if (external.success && external.environment) {
      this._applyExternal(external, {
        status: external.diagnostics?.degraded ? ENVIRONMENT_STATUS.DEGRADED : ENVIRONMENT_STATUS.READY,
        diagnostics: external.diagnostics,
        error: null,
      });
      this._applyDiagnostics(external.diagnostics);
      return this.getState();
    }
    if (!external.success) {
      this.source = "external";
      this.externalActive = null;
      this._emit({
        source: this.source,
        status: ENVIRONMENT_STATUS.NEEDS_REPAIR,
        activePath: external.config?.environment?.normalizedPath || external.config?.normalizedPath || null,
        selectedAccelerator: external.config?.environment?.accelerator || external.config?.accelerator || null,
        detectedAccelerator: external.config?.environment?.accelerator || external.config?.accelerator || null,
        externalConfigured: true,
        externalPath: external.config?.environment?.normalizedPath || external.config?.normalizedPath || null,
        externalLayout: external.config?.environment?.layout || external.config?.layout || null,
        externalFingerprint: external.config?.environment?.fingerprint || external.config?.fingerprint || null,
        externalLastVerifiedAt: external.config?.environment?.lastVerifiedAt || external.config?.lastVerifiedAt || null,
        error: normalizeError(external, external.code || "EXTERNAL_ENV_REPROBE_FAILED"),
      });
      return this.getState();
    }
    if (this.active) {
      this._applyActive(this.active, { status: ENVIRONMENT_STATUS.READY, error: null });
    } else {
      this._emit({ status: ENVIRONMENT_STATUS.NEEDS_CREATE, error: null });
    }
    return this.getState();
  }

  async setAccelerator(preference) {
    try {
      this.preference = normalizeAcceleratorPreference(preference);
      this.preferenceExplicit = true;
      await this._writePreference();
      const activeMatches = this.active?.accelerator === this.preference || this.preference === "auto";
      const status = this.source === "external"
        ? this.state.status
        : activeMatches && this.active
          ? ENVIRONMENT_STATUS.READY
          : ENVIRONMENT_STATUS.NEEDS_CREATE;
      this._emit({
        preference: this.preference,
        preferenceExplicit: this.preferenceExplicit,
        status,
        error: null,
      });
      return { success: true, preference: this.preference, state: this.getState() };
    } catch (error) {
      const normalized = normalizeError(error, "ENVIRONMENT_ACCELERATOR_UNSUPPORTED");
      this._emit({ error: normalized, status: ENVIRONMENT_STATUS.FAILED });
      return { success: false, ...normalized, state: this.getState() };
    }
  }

  _environmentUpdateUnavailable(reason, code = "ENVIRONMENT_UPDATE_UNAVAILABLE") {
    return {
      success: false,
      available: false,
      code,
      reason,
      requiredAction: "请先创建或修复可用运行环境，再检查运行环境更新。",
      state: this.getState(),
    };
  }

  _currentEnvironmentAccelerator() {
    return this.source === "external"
      ? this.externalActive?.accelerator || this.state.selectedAccelerator || null
      : this.active?.accelerator || this.state.selectedAccelerator || null;
  }

  _getAcceleratorUpdateFields(
    selection,
    currentAccelerator = this._currentEnvironmentAccelerator(),
    { canActivate = true } = {},
  ) {
    const nvidia = selection?.nvidia || {};
    const isManaged = this.source === "managed";
    const compatible = Boolean(nvidia.compatible);
    let reason = null;
    if (this.source === "external") {
      reason = "当前使用已有运行环境。请在服务管理中切换回自动管理的运行环境后，再切换 CPU 或 CUDA 运行环境。";
    } else if (!canActivate) {
      reason = "当前有任务或服务进程正在运行。请停止服务并等待任务完成后再切换运行环境。";
    } else if (!compatible) {
      const driverMajor = Number(nvidia.driverMajor);
      if (!nvidia.available) {
        reason = "未检测到可用的 NVIDIA 显卡或驱动。请安装兼容 NVIDIA 显卡及可用驱动后重新检测。";
      } else if (Number.isFinite(driverMajor) && driverMajor < this.minimumDriverMajor) {
        reason = `检测到 NVIDIA ${nvidia.gpuName || "显卡"}，驱动 ${nvidia.driverVersion || "版本未知"} 不满足 CUDA 13.0 的最低要求（${this.minimumDriverMajor}+）。请升级 NVIDIA 驱动后重新检测。`;
      } else {
        reason = "未读取到可用于 CUDA 13.0 的 NVIDIA 驱动版本。请安装或更新 NVIDIA 驱动后重新检测。";
      }
    }
    return {
      nvidiaDeviceName: nvidia.gpuName || null,
      nvidiaDriverVersion: nvidia.driverVersion || null,
      canSwitchToCu130: Boolean(isManaged && canActivate && currentAccelerator !== "cu130" && compatible),
      canSwitchToCpu: Boolean(isManaged && canActivate && currentAccelerator !== "cpu"),
      acceleratorChangeReason: reason,
    };
  }

  _applyAcceleratorSelection(selection, currentAccelerator = this._currentEnvironmentAccelerator()) {
    return this._emit(this._getAcceleratorUpdateFields(selection, currentAccelerator));
  }

  async getUpdateStatus({ signal } = {}) {
    if (!this.enabled) {
      return this._environmentUpdateUnavailable("当前无可用运行环境。", "ENVIRONMENT_DISABLED");
    }
    if (!ENVIRONMENT_UPDATE_READY_STATUSES.includes(this.state.status)) {
      return this._environmentUpdateUnavailable("当前无可用运行环境。", "ENVIRONMENT_NOT_READY");
    }

    let selection;
    try {
      selection = await this.bootstrap.detector({
        preference: "auto",
        runner: this.bootstrap.acceleratorRunner,
        minimumDriverMajor: this.minimumDriverMajor,
        signal,
      });
    } catch (error) {
      selection = {
        selectedAccelerator: "cpu",
        reason: error?.message || "NVIDIA 检测不可用。",
        nvidia: {
          available: false,
          compatible: false,
          gpuName: null,
          driverVersion: null,
          driverMajor: null,
          reason: error?.message || "NVIDIA 检测不可用。",
        },
      };
    }

    const diagnostics = this.diagnostics || this.state.diagnostics || {};
    const nvidia = selection?.nvidia || {};
    const currentAccelerator = this._currentEnvironmentAccelerator();
    const canActivate = this.source === "managed" && await this.canActivate().catch(() => false);
    const acceleratorFields = this._getAcceleratorUpdateFields(selection, currentAccelerator, { canActivate });
    const canSwitchToCu130 = acceleratorFields.canSwitchToCu130;
    const canSwitchToCpu = acceleratorFields.canSwitchToCpu;
    const acceleratorChangeReason = acceleratorFields.acceleratorChangeReason;
    return {
      success: true,
      available: true,
      checkedAt: new Date().toISOString(),
      source: this.source,
      status: this.state.status,
      currentAccelerator,
      python: {
        version: diagnostics.python?.version || this.state.pythonVersion || null,
      },
      torch: {
        version: diagnostics.torch?.version || this.state.torchVersion || null,
        cudaVersion: diagnostics.cuda?.version || this.state.cudaVersion || null,
        cudaAvailable: diagnostics.cuda?.available ?? this.state.cudaAvailable ?? null,
      },
      gpu: {
        detected: Boolean(nvidia.available),
        model: nvidia.gpuName || null,
        driverVersion: nvidia.driverVersion || null,
        driverMajor: nvidia.driverMajor ?? null,
        cu130Compatible: Boolean(nvidia.compatible),
        minimumDriverMajor: this.minimumDriverMajor,
        reason: nvidia.reason || null,
      },
      nvidiaDeviceName: acceleratorFields.nvidiaDeviceName,
      nvidiaDriverVersion: acceleratorFields.nvidiaDriverVersion,
      canSwitchToCu130,
      canSwitchToCpu,
      acceleratorChangeReason,
      state: { ...this.getState(), ...acceleratorFields },
    };
  }

  async getUpdatePlan({ target, accelerator, signal } = {}) {
    let targetAccelerator;
    try {
      targetAccelerator = normalizeAcceleratorPreference(target ?? accelerator);
    } catch (error) {
      return {
        success: false,
        allowed: false,
        code: "ENVIRONMENT_ACCELERATOR_UNSUPPORTED",
        reason: error.message,
        requiredAction: "请选择 CPU 或 NVIDIA/cu130。",
        state: this.getState(),
      };
    }
    if (targetAccelerator === "auto") {
      return {
        success: false,
        allowed: false,
        code: "ENVIRONMENT_UPDATE_TARGET_REQUIRED",
        reason: "运行环境更新必须指定 CPU 或 NVIDIA/cu130 目标。",
        requiredAction: "请选择要切换的运行环境类型。",
        state: this.getState(),
      };
    }

    const status = await this.getUpdateStatus({ signal });
    if (!status.success) {
      return {
        ...status,
        allowed: false,
        targetAccelerator,
      };
    }
    if (this.source === "external") {
      return {
        success: false,
        allowed: false,
        code: "EXTERNAL_ENV_READ_ONLY",
        targetAccelerator,
        currentAccelerator: status.currentAccelerator,
        status,
        reason: "当前使用已有运行环境，不能由应用替换其 Python 或 PyTorch 包。",
        requiredAction: "请在后端管理中切换回自动管理的运行环境后再执行此操作。",
        state: this.getState(),
      };
    }
    if (status.currentAccelerator === targetAccelerator) {
      return {
        success: true,
        allowed: false,
        code: "ENVIRONMENT_TARGET_ALREADY_ACTIVE",
        targetAccelerator,
        currentAccelerator: status.currentAccelerator,
        status,
        reason: `当前已在使用 ${targetAccelerator === "cu130" ? "NVIDIA/cu130" : "CPU"} 运行环境。`,
        requiredAction: "无需切换；可使用环境检测确认当前运行环境。",
        state: this.getState(),
      };
    }
    if (targetAccelerator === "cu130" && !status.gpu.cu130Compatible) {
      const driver = status.gpu.driverVersion || "未检测到";
      return {
        success: false,
        allowed: false,
        code: "ENVIRONMENT_CU130_UNAVAILABLE",
        targetAccelerator,
        currentAccelerator: status.currentAccelerator,
        status,
        reason: `当前 NVIDIA 驱动 ${driver} 不满足 CUDA 13.0 的最低要求。`,
        requiredAction: `请安装或更新 NVIDIA 驱动至 ${status.gpu.minimumDriverMajor}+，然后重新检查。`,
        state: this.getState(),
      };
    }
    if (!(await this.canActivate())) {
      return {
        success: false,
        allowed: false,
        code: "ENVIRONMENT_BUSY",
        targetAccelerator,
        currentAccelerator: status.currentAccelerator,
        status,
        reason: "当前有任务或服务进程正在运行，暂时不能切换运行环境。",
        requiredAction: "请停止服务并等待任务完成后再切换。",
        state: this.getState(),
      };
    }
    return {
      success: true,
      allowed: true,
      requiresConfirmation: true,
      targetAccelerator,
      currentAccelerator: status.currentAccelerator,
      status,
      reason: null,
      requiredAction: null,
      state: this.getState(),
    };
  }

  async switchEnvironment({ target, accelerator, confirmed = false, signal, onProgress } = {}) {
    const plan = await this.getUpdatePlan({ target: target ?? accelerator, signal });
    if (!plan.allowed) return { success: false, ...plan, state: this.getState() };
    if (confirmed !== true) {
      return {
        success: false,
        code: "ENVIRONMENT_SWITCH_CONFIRMATION_REQUIRED",
        plan,
        reason: "请确认后再切换运行环境。",
        requiredAction: "确认后将创建或修复目标运行环境。",
        state: this.getState(),
      };
    }

    const result = await this.ensure({
      accelerator: plan.targetAccelerator,
      signal,
      onProgress,
    });
    let preferencePersisted = true;
    let preferenceWarning = null;
    if (result.success) {
      this.preference = plan.targetAccelerator;
      this.preferenceExplicit = true;
      try {
        await this._writePreference();
        this._emit({ preference: this.preference, preferenceExplicit: true });
      } catch (error) {
        const normalized = normalizeError(error, "ENVIRONMENT_PREFERENCE_WRITE_FAILED");
        this._emit({ error: normalized });
        preferencePersisted = false;
        preferenceWarning = normalized;
      }
    }
    const updateStatus = result.success
      ? await this.getUpdateStatus({ signal }).catch(() => null)
      : null;
    return {
      ...result,
      plan,
      updateStatus,
      preferencePersisted,
      preferenceWarning,
      needsPrepare: false,
      preparationStarted: Boolean(this.activePreparation || this.state.status === ENVIRONMENT_STATUS.PREPARING),
      state: this.getState(),
    };
  }

  async check({ accelerator = this.preference, signal } = {}) {
    if (!this.enabled) return { success: false, code: "ENVIRONMENT_DISABLED", state: this.getState() };
    this._emit({ status: ENVIRONMENT_STATUS.CHECKING, error: null, progress: null });
    if (this.source === "external") {
      const external = await this.externalEnvironment.reprobeConfigured({ signal });
      if (!external.success || !external.environment) {
        this.externalActive = null;
        const error = normalizeError(external, external.code || "EXTERNAL_ENV_REPROBE_FAILED");
        this._emit({
          source: "external",
          status: ENVIRONMENT_STATUS.NEEDS_REPAIR,
          externalConfigured: Boolean(external.config || this.state.externalConfigured),
          error,
        });
        return { success: false, ...error, state: this.getState() };
      }
      this._applyExternal(external, {
        status: external.diagnostics?.degraded ? ENVIRONMENT_STATUS.DEGRADED : ENVIRONMENT_STATUS.READY,
        diagnostics: external.diagnostics,
        error: null,
      });
      this._applyDiagnostics(external.diagnostics);
      return { ...external, state: this.getState() };
    }
    try {
      const result = await this.bootstrap.check({ accelerator, signal });
      this.active = result.active || null;
      if (result.selection) {
        this._applyAcceleratorSelection(
          result.selection,
          this.active?.accelerator || result.selectedAccelerator || null,
        );
      }
      if (!result.ready) {
        this._emit({
          status: ENVIRONMENT_STATUS.NEEDS_CREATE,
          selectedAccelerator: result.selectedAccelerator,
          detectedAccelerator: result.selectedAccelerator,
          reason: result.selection?.reason || null,
          activePath: this.active?.absolutePath || null,
          specHash: this.active?.specHash || null,
        });
        return { ...result, state: this.getState() };
      }
      const activePath = this.active?.absolutePath;
      const pythonExecutable = this._activePythonExecutable(activePath);
      const health = activePath && typeof this.bootstrap.probe === "function"
        ? await this.bootstrap.probe({
          root: activePath,
          pythonExecutable,
          ffmpegPath: this._activeFfmpegPath(activePath),
          accelerator: result.selectedAccelerator,
          signal,
        })
        : null;
      if (health?.success === false) {
        this._applyActive(this.active, {
          status: "needs-repair",
          reason: result.selection?.reason || null,
          diagnostics: health,
          error: { message: "本机运行环境探针失败，请执行修复。", code: "ENVIRONMENT_PROBE_FAILED" },
        });
        this._applyDiagnostics(health);
        return { ...result, success: false, code: "ENVIRONMENT_PROBE_FAILED", health, state: this.getState() };
      }
      const status = health?.degraded ? ENVIRONMENT_STATUS.DEGRADED : ENVIRONMENT_STATUS.READY;
      this._applyActive(this.active, {
        status,
        reason: result.selection?.reason || null,
        diagnostics: health,
        error: null,
      });
      this._applyDiagnostics(health);
      return { ...result, health, state: this.getState() };
    } catch (error) {
      const normalized = normalizeError(error, "ENVIRONMENT_CHECK_FAILED");
      if (normalized.code === "ENVIRONMENT_CU130_UNAVAILABLE" && this.active) {
        this._applyActive(this.active, {
          status: this.diagnostics?.degraded ? ENVIRONMENT_STATUS.DEGRADED : ENVIRONMENT_STATUS.READY,
          reason: normalized.message,
          error: null,
        });
        return {
          success: false,
          ...normalized,
          capabilityWarning: true,
          preservedActive: true,
          state: this.getState(),
        };
      }
      this._emit({ status: ENVIRONMENT_STATUS.FAILED, error: normalized });
      return { success: false, ...normalized, state: this.getState() };
    }
  }

  async ensure(options = {}) {
    const accelerator = options.accelerator ?? this.preference;
    if (!this.enabled) return { success: false, code: "ENVIRONMENT_DISABLED", state: this.getState() };
    if (this.source === "external") return this.check({ signal: options.signal });
    if (this.activePreparation) {
      return {
        success: false,
        code: "ENVIRONMENT_OPERATION_IN_PROGRESS",
        error: "运行环境正在准备中。",
        state: this.getState(),
      };
    }

    const operationId = preparationOperationId();
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(options.signal?.reason || createPreparationCancellation());
    if (options.signal?.aborted) forwardAbort();
    else options.signal?.addEventListener?.("abort", forwardAbort, { once: true });
    const operation = { operationId, controller, promise: null };
    this.activePreparation = operation;
    operation.promise = this._ensureManaged({
      ...options,
      accelerator,
      signal: controller.signal,
      operationId,
    });
    try {
      return await operation.promise;
    } finally {
      options.signal?.removeEventListener?.("abort", forwardAbort);
      if (this.activePreparation === operation) {
        this.activePreparation = null;
        this._emit({ operationId: null, canCancel: false });
      }
    }
  }

  cancelPreparation() {
    const operation = this.activePreparation;
    if (!operation) {
      return { success: false, code: "ENVIRONMENT_NO_ACTIVE_OPERATION", state: this.getState() };
    }
    if (!operation.controller.signal.aborted) {
      this._emit({ status: ENVIRONMENT_STATUS.CANCELLING, canCancel: false, error: null });
      operation.controller.abort(createPreparationCancellation());
    }
    return { success: true, cancelling: true, operationId: operation.operationId, state: this.getState() };
  }

  async waitForPreparation() {
    const operation = this.activePreparation;
    if (!operation?.promise) return { success: true, settled: true };
    const result = await operation.promise.catch((error) => ({ success: false, error: error?.message || String(error) }));
    return { success: true, settled: true, result };
  }

  async _ensureManaged({
    accelerator = this.preference,
    force = false,
    sourceOverrides = {},
    signal,
    onProgress,
    operationId,
  } = {}) {
    if (!this.enabled) return { success: false, code: "ENVIRONMENT_DISABLED", state: this.getState() };
    if (this.source === "external") return this.check({ signal });
    const canActivate = await this.canActivate();
    if (!canActivate) {
      const error = { code: "ENVIRONMENT_BUSY", message: "当前有任务或服务进程正在运行，暂时不能切换运行环境。" };
      this._emit({ status: ENVIRONMENT_STATUS.FAILED, error });
      return { success: false, ...error, state: this.getState() };
    }
    this._emit({
      status: ENVIRONMENT_STATUS.PREPARING,
      error: null,
      progress: null,
      operationId,
      canCancel: true,
      targetPath: null,
    });
    let lastProgress = null;
    const reportProgress = (progress) => {
      if (!progress || typeof progress !== "object") return;
      if (progress.logOnly) {
        try {
          onProgress?.(clone(progress));
        } catch {
          // Log observers must not affect environment creation.
        }
        return;
      }
      lastProgress = clone(progress);
      this._emit({
        status: progress.status === "cancelled" ? ENVIRONMENT_STATUS.CANCELLING : ENVIRONMENT_STATUS.PREPARING,
        progress: lastProgress,
        targetPath: progress.environmentPath || this.state.targetPath || null,
        error: null,
      });
      try {
        onProgress?.(clone(lastProgress));
      } catch {
        // Progress observers must not affect environment creation.
      }
    };
    try {
      const previousActivePath = this.active?.absolutePath || null;
      const previousSpecHash = this.active?.specHash || null;
      const offlinePayloadRoot = await this._resolveOfflinePayloadRoot();
      const shouldImportOffline = Boolean(offlinePayloadRoot) && (!this.active || force);
      const result = shouldImportOffline
        ? await this.bootstrap.importOfflinePayload({
          offlinePayloadRoot,
          accelerator,
          force,
          signal,
        })
        : await this.bootstrap.bootstrap({
          accelerator,
          force,
          sourceOverrides,
          signal,
          onProgress: reportProgress,
        });
      if (result.success && result.state && (!lastProgress || lastProgress.percent !== 100)) {
        const steps = result.state.steps || [];
        reportProgress({ percent: 100, phase: "complete", status: "complete", message: "运行环境准备完成。", steps });
      }
      this.active = await this.bootstrap.getActive();
      if (result.selection) {
        this._applyAcceleratorSelection(
          result.selection,
          this.active?.accelerator || result.selectedAccelerator || accelerator,
        );
      }
      if (!result.success) {
        if (result.cancelled || result.code === "ENVIRONMENT_PREPARATION_CANCELLED") {
          const fallbackStatus = this.active
            ? this.diagnostics?.degraded
              ? ENVIRONMENT_STATUS.DEGRADED
              : ENVIRONMENT_STATUS.READY
            : ENVIRONMENT_STATUS.NEEDS_CREATE;
          this._emit({
            status: fallbackStatus,
            error: null,
            progress: lastProgress ? { ...lastProgress, status: "cancelled", error: null } : null,
            canCancel: false,
          });
          return { ...result, error: null, state: this.getState() };
        }
        if (result.code === "ENVIRONMENT_CU130_UNAVAILABLE" && this.active) {
          const warning = {
            code: result.code,
            message: result.error || "当前 NVIDIA 驱动不满足 cu130 环境要求，已保留现有运行环境。",
            details: result.details || {},
          };
          this._applyActive(this.active, {
            status: this.diagnostics?.degraded ? ENVIRONMENT_STATUS.DEGRADED : ENVIRONMENT_STATUS.READY,
            reason: warning.message,
            error: null,
            progress: null,
          });
          return {
            ...result,
            capabilityWarning: true,
            preservedActive: true,
            warning,
            state: this.getState(),
          };
        }
        const error = {
          message: result.error || "本机运行环境创建失败。",
          code: result.code || "ENVIRONMENT_BOOTSTRAP_FAILED",
          details: result.details || {},
        };
        this._emit({
          status: ENVIRONMENT_STATUS.FAILED,
          error,
          progress: lastProgress ? { ...lastProgress, status: "failed", error } : null,
        });
        return { ...result, error: error.message, state: this.getState() };
      }
      this._applyActive(this.active, {
        status: result.health?.degraded ? ENVIRONMENT_STATUS.DEGRADED : ENVIRONMENT_STATUS.READY,
        reason: result.selection?.reason || null,
        diagnostics: result.health || null,
        progress: null,
        restartRequired: Boolean(
          force ||
          result.created ||
          result.imported ||
          previousActivePath !== (this.active?.absolutePath || null) ||
          previousSpecHash !== (this.active?.specHash || null)
        ),
        error: null,
      });
      if (result.offline && result.modelsPath) {
        try {
          await this._copyMissingModelFiles(result.modelsPath);
        } catch (error) {
          this._emit({
            error: {
              message: "随附模型已校验，但复制到模型路径失败。",
              code: "ENVIRONMENT_MODEL_IMPORT_FAILED",
              details: { reason: error.message },
            },
          });
        }
      }
      if (result.health) this._applyDiagnostics(result.health);
      return { ...result, state: this.getState() };
    } catch (error) {
      const normalized = normalizeError(error);
      this._emit({
        status: ENVIRONMENT_STATUS.FAILED,
        error: normalized,
        progress: lastProgress ? { ...lastProgress, status: "failed", error: normalized } : null,
      });
      return { success: false, ...normalized, state: this.getState() };
    }
  }

  async probeExternalEnvironment({ directoryPath, signal } = {}) {
    if (!this.enabled) return { success: false, code: "ENVIRONMENT_DISABLED", state: this.getState() };
    const previousStatus = this.state.status;
    this._emit({ status: ENVIRONMENT_STATUS.VERIFYING, error: null });
    const result = await this.externalEnvironment.probeDirectory({ directoryPath, signal });
    if (!result.success) {
      const error = normalizeError(result, result.code || "EXTERNAL_ENV_PROBE_FAILED");
      this._emit({ status: previousStatus, error });
      return { ...result, state: this.getState() };
    }
    this._emit({
      status: previousStatus,
      externalCandidateToken: result.candidateToken,
      externalCandidateExpiresAt: result.candidateExpiresAt,
      externalPath: result.environment?.normalizedPath || null,
      externalLayout: result.environment?.layout || null,
      error: null,
    });
    return { ...result, state: this.getState() };
  }

  async activateExternalEnvironment({ candidateToken, signal } = {}) {
    if (!this.enabled) return { success: false, code: "ENVIRONMENT_DISABLED", state: this.getState() };
    if (!(await this.canActivate())) {
      const error = { code: "ENVIRONMENT_BUSY", message: "当前有任务或服务进程正在运行，暂时不能切换运行环境。" };
      this._emit({ error });
      return { success: false, ...error, state: this.getState() };
    }
    const previousStatus = this.state.status;
    this._emit({ status: ENVIRONMENT_STATUS.VERIFYING, error: null });
    const result = await this.externalEnvironment.activateCandidate({ candidateToken, signal });
    if (!result.success) {
      const error = normalizeError(result, result.code || "EXTERNAL_ENV_ACTIVATION_FAILED");
      this._emit({
        status: previousStatus,
        externalCandidateToken: null,
        externalCandidateExpiresAt: null,
        error,
      });
      return { ...result, state: this.getState() };
    }
    this._applyExternal(result, {
      status: result.diagnostics?.degraded ? ENVIRONMENT_STATUS.DEGRADED : ENVIRONMENT_STATUS.READY,
      diagnostics: result.diagnostics,
      restartRequired: true,
      error: null,
    });
    this._applyDiagnostics(result.diagnostics);
    return { ...result, state: this.getState() };
  }

  async forgetExternalEnvironment({ signal } = {}) {
    if (!this.enabled) return { success: false, code: "ENVIRONMENT_DISABLED", state: this.getState() };
    if (!(await this.canActivate())) {
      return { success: false, code: "ENVIRONMENT_BUSY", state: this.getState() };
    }
    await this.externalEnvironment.forget();
    this.source = "managed";
    this.externalActive = null;
    this.active = await this.bootstrap.getActive();
    this._resetExternalState({
      source: this.source,
      activePath: this.active?.absolutePath || null,
      specHash: this.active?.specHash || null,
      selectedAccelerator: this.active?.accelerator || null,
      detectedAccelerator: this.active?.accelerator || null,
      status: this.active ? ENVIRONMENT_STATUS.CHECKING : ENVIRONMENT_STATUS.NEEDS_CREATE,
      restartRequired: true,
      diagnostics: null,
      error: null,
    });
    if (!this.active) return { success: true, fallback: "needs-create", state: this.getState() };
    const checked = await this.check({ accelerator: this.active.accelerator || this.preference, signal });
    if (
      !checked.success ||
      ![ENVIRONMENT_STATUS.READY, ENVIRONMENT_STATUS.DEGRADED].includes(this.state.status)
    ) {
      this.active = null;
      this._emit({
        status: ENVIRONMENT_STATUS.NEEDS_CREATE,
        activePath: null,
        specHash: null,
        selectedAccelerator: null,
        detectedAccelerator: null,
        diagnostics: null,
        error: null,
      });
      return { success: true, fallback: "needs-create", check: checked, state: this.getState() };
    }
    return { success: true, fallback: "managed", check: checked, state: this.getState() };
  }

  _applyDiagnostics(diagnostics) {
    if (!diagnostics) return;
    this.diagnostics = diagnostics;
    this._emit({
      diagnostics,
      pythonVersion: diagnostics.python?.version || null,
      torchVersion: diagnostics.torch?.version || null,
      cudaVersion: diagnostics.cuda?.version || null,
      cudaAvailable: diagnostics.cuda?.available ?? null,
      ffmpegVersion: diagnostics.ffmpeg?.version || null,
      ffmpegPath: diagnostics.ffmpeg?.path || this.ffmpegSourcePath || null,
      videoAvailable: diagnostics.capabilities?.video ?? diagnostics.ffmpeg?.ok ?? null,
    });
  }

  async rollback() {
    if (!this.enabled) return { success: false, code: "ENVIRONMENT_DISABLED", state: this.getState() };
    if (this.source === "external") {
      return {
        success: false,
        code: "EXTERNAL_ENV_READ_ONLY",
        error: "External environments are read-only; stop using it before rolling back a managed environment.",
        state: this.getState(),
      };
    }
    if (!(await this.canActivate())) return { success: false, code: "ENVIRONMENT_BUSY", state: this.getState() };
    this._emit({ status: ENVIRONMENT_STATUS.ROLLING_BACK, error: null });
    const result = await this.bootstrap.rollback();
    if (!result.success) {
      this._emit({ status: ENVIRONMENT_STATUS.FAILED, error: { message: result.error, code: result.code } });
      return { ...result, state: this.getState() };
    }
    this.active = await this.bootstrap.getActive();
    this._applyActive(this.active, {
      status: ENVIRONMENT_STATUS.READY,
      restartRequired: true,
      error: null,
    });
    return { ...result, state: this.getState() };
  }

  getActiveBackendSpec() {
    if (this.source === "external") {
      if (![ENVIRONMENT_STATUS.READY, ENVIRONMENT_STATUS.DEGRADED].includes(this.state.status) || !this.externalActive) return {};
      const ffmpegPath = this.externalEnvironment.ffmpegPath || "";
      return {
        source: "external",
        pythonExecutable: this.externalActive.pythonExecutable,
        pythonRoot: this.externalActive.normalizedPath,
        ffmpegRoot: ffmpegPath ? path.dirname(ffmpegPath) : "",
        ffmpegPath: ffmpegPath || null,
        backendProjectPath: this.backendProjectPath,
        accelerator: this.externalActive.accelerator,
        specHash: null,
        environmentRoot: this.externalActive.normalizedPath,
        layout: this.externalActive.layout,
        fingerprint: this.externalActive.fingerprint,
      };
    }
    const activePath = this.active?.absolutePath || this.state.activePath;
    if (!activePath) return {};
    const pythonExecutable = this._activePythonExecutable(activePath);
    return {
      source: "managed",
      pythonExecutable,
      pythonRoot: activePath,
      ffmpegRoot: this.ffmpegSourcePath ? path.dirname(this.ffmpegSourcePath) : path.join(activePath, "ffmpeg"),
      ffmpegPath: this._activeFfmpegPath(activePath),
      backendProjectPath: this.backendProjectPath,
      accelerator: this.active?.accelerator || this.state.selectedAccelerator || null,
      specHash: this.active?.specHash || this.state.specHash || null,
      environmentRoot: activePath,
    };
  }
}

export { ACCELERATOR_PREFERENCES };
