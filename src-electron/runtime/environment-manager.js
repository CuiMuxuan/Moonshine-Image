import fs from "node:fs/promises";
import path from "node:path";

import { EnvironmentBootstrap } from "./environment-bootstrap.js";
import { ExternalEnvironmentService } from "./external-environment.js";
import {
  ACCELERATOR_PREFERENCES,
  normalizeAcceleratorPreference,
} from "./environment-spec.js";

const PREFERENCE_FILE = "preference.json";

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

export const ENVIRONMENT_STATUS = Object.freeze({
  DISABLED: "disabled",
  IDLE: "idle",
  CHECKING: "checking",
  READY: "ready",
  NEEDS_CREATE: "needs-create",
  NEEDS_REPAIR: "needs-repair",
  PREPARING: "preparing",
  VERIFYING: "verifying",
  FAILED: "failed",
  ROLLING_BACK: "rolling-back",
});

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
    this.active = null;
    this.source = "managed";
    this.externalActive = null;
    this.diagnostics = null;
    this.state = {
      enabled: this.enabled,
      status: this.enabled ? ENVIRONMENT_STATUS.IDLE : ENVIRONMENT_STATUS.DISABLED,
      source: this.source,
      preference: this.preference,
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
      diagnostics: null,
      error: null,
      progress: null,
      restartRequired: false,
      externalConfigured: false,
      externalPath: null,
      externalLayout: null,
      externalFingerprint: null,
      externalLastVerifiedAt: null,
      externalCandidateToken: null,
      externalCandidateExpiresAt: null,
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
      minimumDriverMajor,
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
      this.preference = normalizeAcceleratorPreference(value.preference);
    } catch (error) {
      if (error?.code !== "ENOENT") this.preference = "auto";
    }
    this._emit({ preference: this.preference });
  }

  async _writePreference() {
    await fs.mkdir(path.dirname(this.preferencePath), { recursive: true });
    const temporary = `${this.preferencePath}.tmp-${process.pid}`;
    await fs.writeFile(temporary, `${JSON.stringify({ preference: this.preference }, null, 2)}\n`, {
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
    if (this.active?.pythonExecutableRelative) {
      return path.resolve(activePath, this.active.pythonExecutableRelative);
    }
    return path.join(activePath, "venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
  }

  _activeFfmpegPath(activePath = this.active?.absolutePath || this.state.activePath) {
    if (!activePath) return null;
    if (this.active?.ffmpegRelative) return path.resolve(activePath, this.active.ffmpegRelative);
    return path.join(activePath, "ffmpeg", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  }

  async initialize() {
    if (!this.enabled) return this.getState();
    await this._readPreference();
    this.active = await this.bootstrap.getActive();
    const external = await this.externalEnvironment.reprobeConfigured();
    if (external.success && external.environment) {
      this._applyExternal(external, { status: ENVIRONMENT_STATUS.READY, diagnostics: external.diagnostics, error: null });
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
      await this._writePreference();
      const activeMatches = this.active?.accelerator === this.preference || this.preference === "auto";
      const status = this.source === "external"
        ? this.state.status
        : activeMatches && this.active
          ? ENVIRONMENT_STATUS.READY
          : ENVIRONMENT_STATUS.NEEDS_CREATE;
      this._emit({ preference: this.preference, status, error: null });
      return { success: true, preference: this.preference, state: this.getState() };
    } catch (error) {
      const normalized = normalizeError(error, "ENVIRONMENT_ACCELERATOR_UNSUPPORTED");
      this._emit({ error: normalized, status: ENVIRONMENT_STATUS.FAILED });
      return { success: false, ...normalized, state: this.getState() };
    }
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
        status: ENVIRONMENT_STATUS.READY,
        diagnostics: external.diagnostics,
        error: null,
      });
      this._applyDiagnostics(external.diagnostics);
      return { ...external, state: this.getState() };
    }
    try {
      const result = await this.bootstrap.check({ accelerator, signal });
      this.active = result.active || null;
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
      this._applyActive(this.active, {
        status: ENVIRONMENT_STATUS.READY,
        reason: result.selection?.reason || null,
        diagnostics: health,
        error: null,
      });
      this._applyDiagnostics(health);
      return { ...result, health, state: this.getState() };
    } catch (error) {
      const normalized = normalizeError(error, "ENVIRONMENT_CHECK_FAILED");
      this._emit({ status: ENVIRONMENT_STATUS.FAILED, error: normalized });
      return { success: false, ...normalized, state: this.getState() };
    }
  }

  async ensure({ accelerator = this.preference, force = false, sourceOverrides = {}, signal, onProgress } = {}) {
    if (!this.enabled) return { success: false, code: "ENVIRONMENT_DISABLED", state: this.getState() };
    if (this.source === "external") return this.check({ signal });
    const canActivate = await this.canActivate();
    if (!canActivate) {
      const error = { code: "ENVIRONMENT_BUSY", message: "当前有任务或后端进程正在运行，暂时不能切换运行环境。" };
      this._emit({ status: ENVIRONMENT_STATUS.FAILED, error });
      return { success: false, ...error, state: this.getState() };
    }
    this._emit({ status: ENVIRONMENT_STATUS.PREPARING, error: null, progress: null });
    let lastProgress = null;
    const reportProgress = (progress) => {
      if (!progress || typeof progress !== "object") return;
      lastProgress = clone(progress);
      this._emit({ status: ENVIRONMENT_STATUS.PREPARING, progress: lastProgress, error: null });
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
      if (!result.success) {
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
        status: ENVIRONMENT_STATUS.READY,
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
              message: "离线模型已校验，但复制到模型目录失败。",
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
      const error = { code: "ENVIRONMENT_BUSY", message: "当前有任务或后端进程正在运行，暂时不能切换运行环境。" };
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
      status: ENVIRONMENT_STATUS.READY,
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
    if (!checked.success || this.state.status !== ENVIRONMENT_STATUS.READY) {
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
      if (this.state.status !== ENVIRONMENT_STATUS.READY || !this.externalActive) return {};
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
      ffmpegRoot: path.join(activePath, "ffmpeg"),
      backendProjectPath: this.backendProjectPath,
      accelerator: this.active?.accelerator || this.state.selectedAccelerator || null,
      specHash: this.active?.specHash || this.state.specHash || null,
      environmentRoot: activePath,
    };
  }
}

export { ACCELERATOR_PREFERENCES };
