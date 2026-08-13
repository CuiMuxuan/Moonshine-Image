import { normalizeAppUpdateChannel } from "./update-channel.js";
const DEFAULT_INITIAL_CHECK_DELAY_MS = 30_000;

export const APP_UPDATE_STATUS = Object.freeze({
  DISABLED: "disabled",
  IDLE: "idle",
  CHECKING: "checking",
  UP_TO_DATE: "up-to-date",
  AVAILABLE: "available",
  DOWNLOADING: "downloading",
  DOWNLOADED: "downloaded",
  INSTALLING: "installing",
  ERROR: "error",
});

export const APP_UPDATE_ACTION = Object.freeze({
  CHECK: "check",
  DOWNLOAD: "download",
  INSTALL: "install",
});

const EVENT_NAMES = Object.freeze([
  "checking-for-update",
  "update-available",
  "update-not-available",
  "download-progress",
  "update-downloaded",
  "error",
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function toFiniteNumber(value, fallback = 0) {
  try {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  } catch {
    return fallback;
  }
}

function clampProgress(value) {
  return Math.min(100, Math.max(0, toFiniteNumber(value)));
}

function toNullableString(value) {
  if (value === null || value === undefined || value === "") return null;
  try {
    return String(value);
  } catch {
    return null;
  }
}

function normalizeAction(action) {
  return Object.values(APP_UPDATE_ACTION).includes(action) ? action : null;
}

export function normalizeUpdaterError(error, options = {}) {
  const phase = normalizeAction(options.phase || error?.phase);
  const retryAction = normalizeAction(options.retryAction || error?.retryAction || phase);
  if (!error) {
    return {
      message: "Unknown update error.",
      code: null,
      phase,
      retryAction,
    };
  }

  return {
    message: toNullableString(error.message || error) || "Unknown update error.",
    code: toNullableString(error.code),
    phase,
    retryAction,
  };
}

export function createDefaultUpdateState(options = {}) {
  const enabled = Boolean(options.enabled);
  const channel = normalizeAppUpdateChannel(options.channel);
  const initialError = options.error
    ? normalizeUpdaterError(options.error, {
      phase: options.errorPhase,
      retryAction: options.retryAction,
    })
    : null;
  return {
    enabled,
    edition: options.edition || (channel === "test" ? "test" : "official"),
    channel,
    channelLocked: true,
    status: enabled ? APP_UPDATE_STATUS.IDLE : APP_UPDATE_STATUS.DISABLED,
    currentVersion: toNullableString(options.currentVersion) || "",
    // This is package metadata for the version currently installed, not the
    // timestamp of its most recent update check.
    currentVersionUpdatedAt: toNullableString(options.currentVersionUpdatedAt),
    availableVersion: null,
    latestVersion: null,
    releaseName: null,
    releaseDate: null,
    releaseNotes: null,
    progress: 0,
    bytesPerSecond: 0,
    transferred: 0,
    total: 0,
    checkedAt: null,
    downloadedAt: null,
    error: initialError,
    retryAction: normalizeAction(options.retryAction || initialError?.retryAction),
    installBlockedReason: null,
  };
}

function getUpdateVersion(info) {
  const version = info?.version || info?.versionInfo?.version;
  return toNullableString(version);
}

function getReleaseNotes(info) {
  const notes = info?.releaseNotes;
  if (typeof notes === "string") return notes;
  if (Array.isArray(notes)) {
    return notes
      .map((item) => toNullableString(typeof item === "string" ? item : item?.note) || "")
      .filter(Boolean)
      .join("\n\n");
  }
  return null;
}

function getProgressState(progress = {}) {
  const transferred = Math.max(0, toFiniteNumber(progress.transferred));
  const total = Math.max(0, toFiniteNumber(progress.total));
  const explicitPercent = toFiniteNumber(progress.percent, Number.NaN);
  const derivedPercent = total > 0 ? (transferred / total) * 100 : 0;

  return {
    progress: clampProgress(Number.isFinite(explicitPercent) ? explicitPercent : derivedPercent),
    bytesPerSecond: Math.max(0, toFiniteNumber(progress.bytesPerSecond)),
    transferred,
    total,
  };
}

/**
 * Adapter around electron-updater. The adapter owns the renderer-facing
 * state machine and keeps the Electron API behind a small, injectable seam.
 */
export class AppUpdaterService {
  constructor(options = {}) {
    this.updater = options.updater || null;
    this.send = typeof options.send === "function" ? options.send : () => {};
    this.now = options.now || (() => Date.now());
    this.setTimeout = options.setTimeoutImpl || setTimeout;
    this.clearTimeout = options.clearTimeoutImpl || clearTimeout;
    this.isPackaged = options.isPackaged !== false;
    this.allowDev = Boolean(options.allowDev);
    this.preflight = typeof options.preflight === "function" ? options.preflight : null;
    this.validateUpdateInfo = typeof options.validateUpdateInfo === "function"
      ? options.validateUpdateInfo
      : null;
    this.initialCheckDelayMs = Math.max(
      0,
      toFiniteNumber(options.initialCheckDelayMs, DEFAULT_INITIAL_CHECK_DELAY_MS)
    );
    this.state = createDefaultUpdateState({
      enabled: Boolean(this.updater) && (this.isPackaged || this.allowDev),
      currentVersion: options.currentVersion,
      currentVersionUpdatedAt: options.currentVersionUpdatedAt,
      channel: options.channel,
      edition: options.edition,
      error: options.initialError,
    });
    this.timer = null;
    this.listenersAttached = false;
    this.boundHandlers = new Map();
    this.activeOperation = null;
    this.disposed = false;

    if (this.state.enabled) {
      this.attach();
    }
  }

  getState() {
    return clone(this.state);
  }

  setChannel(channel) {
    if (this.disposed) {
      return { success: false, code: "APP_UPDATE_DISPOSED", state: this.getState() };
    }
    const normalized = normalizeAppUpdateChannel(channel);
    if (normalized === this.state.channel) {
      return { success: true, changed: false, locked: true, channel: normalized, state: this.getState() };
    }
    return {
      success: false,
      changed: false,
      locked: true,
      code: "APP_UPDATE_CHANNEL_LOCKED",
      channel: this.state.channel,
      state: this.getState(),
    };
  }

  attach() {
    if (this.disposed || !this.state.enabled || !this.updater || this.listenersAttached) return false;

    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    if ("autoRunAppAfterInstall" in this.updater) {
      this.updater.autoRunAppAfterInstall = true;
    }

    const handlers = {
      "checking-for-update": () => this._handleChecking(),
      "update-available": (info = {}) => this._handleAvailable(info),
      "update-not-available": (info = {}) => this._handleNotAvailable(info),
      "download-progress": (progress = {}) => this._handleProgress(progress),
      "update-downloaded": (info = {}) => this._handleDownloaded(info),
      error: (error) => this._handleError(error),
    };

    for (const eventName of EVENT_NAMES) {
      const handler = handlers[eventName];
      this.boundHandlers.set(eventName, handler);
      this.updater.on?.(eventName, handler);
    }
    this.listenersAttached = true;
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) {
      this.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.listenersAttached) {
      for (const [eventName, handler] of this.boundHandlers) {
        if (typeof this.updater?.removeListener === "function") {
          this.updater.removeListener(eventName, handler);
        } else {
          this.updater?.off?.(eventName, handler);
        }
      }
    }
    this.boundHandlers.clear();
    this.listenersAttached = false;
    this.activeOperation = null;
  }

  scheduleInitialCheck(delayMs = this.initialCheckDelayMs) {
    if (this.disposed || !this.state.enabled || !this.updater || this.timer) return false;
    this.timer = this.setTimeout(() => {
      this.timer = null;
      void this.checkForUpdates();
    }, Math.max(0, toFiniteNumber(delayMs, this.initialCheckDelayMs)));
    this.timer?.unref?.();
    return true;
  }

  _busyResult() {
    return {
      success: false,
      code: "APP_UPDATE_BUSY",
      operation: this.activeOperation,
      state: this.getState(),
    };
  }

  _beginOperation(action) {
    if (this.activeOperation) return false;
    this.activeOperation = action;
    return true;
  }

  _endOperation(action) {
    if (this.activeOperation === action) this.activeOperation = null;
  }

  _retryMismatch(action) {
    const retryAction = normalizeAction(this.state.retryAction || this.state.error?.retryAction);
    if (this.state.status !== APP_UPDATE_STATUS.ERROR || retryAction === action) return null;
    return {
      success: false,
      code: "APP_UPDATE_RETRY_ACTION_MISMATCH",
      requiredAction: retryAction,
      state: this.getState(),
    };
  }

  _isProtectedFromCheck() {
    return [
      APP_UPDATE_STATUS.DOWNLOADING,
      APP_UPDATE_STATUS.DOWNLOADED,
      APP_UPDATE_STATUS.INSTALLING,
    ].includes(this.state.status);
  }

  _nowIso() {
    try {
      return new Date(this.now()).toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  async checkForUpdates() {
    if (this.disposed) {
      return { success: false, code: "APP_UPDATE_DISPOSED", state: this.getState() };
    }
    if (!this.state.enabled || !this.updater) {
      return { success: false, code: "APP_UPDATE_DISABLED", state: this.getState() };
    }
    if (this.activeOperation) return this._busyResult();

    const retryMismatch = this._retryMismatch(APP_UPDATE_ACTION.CHECK);
    if (retryMismatch) return retryMismatch;

    if (this._isProtectedFromCheck()) {
      return {
        success: false,
        code: this.state.status === APP_UPDATE_STATUS.DOWNLOADED
          ? "APP_UPDATE_ALREADY_DOWNLOADED"
          : "APP_UPDATE_BUSY",
        state: this.getState(),
      };
    }

    this._beginOperation(APP_UPDATE_ACTION.CHECK);

    this._setState({
      status: APP_UPDATE_STATUS.CHECKING,
      checkedAt: null,
      error: null,
      retryAction: null,
      installBlockedReason: null,
    });

    try {
      if (this.preflight) {
        await this.preflight({ channel: this.state.channel });
      }
      const result = await this.updater.checkForUpdates();
      const updateInfo = result?.updateInfo || result?.versionInfo || null;
      if (this.validateUpdateInfo && updateInfo && getUpdateVersion(updateInfo)) {
        this.validateUpdateInfo(updateInfo);
      }
      if (this.state.status === APP_UPDATE_STATUS.CHECKING) {
        if (result?.isUpdateAvailable === false) {
          this._handleNotAvailable(updateInfo || {});
        } else if (updateInfo && getUpdateVersion(updateInfo)) {
          this._handleAvailable(updateInfo);
        } else {
          this._setState({
            status: APP_UPDATE_STATUS.UP_TO_DATE,
            availableVersion: null,
            latestVersion: null,
            releaseName: null,
            releaseDate: null,
            releaseNotes: null,
            checkedAt: this._nowIso(),
            retryAction: null,
          });
        }
      }

      if (
        this.state.status === APP_UPDATE_STATUS.ERROR &&
        this.state.error?.phase === APP_UPDATE_ACTION.CHECK
      ) {
        return {
          success: false,
          code: "APP_UPDATE_CHECK_FAILED",
          error: clone(this.state.error),
          state: this.getState(),
        };
      }
      return { success: true, state: this.getState() };
    } catch (error) {
      this._handleError(error, APP_UPDATE_ACTION.CHECK);
      return {
        success: false,
        code: "APP_UPDATE_CHECK_FAILED",
        error: normalizeUpdaterError(error, {
          phase: APP_UPDATE_ACTION.CHECK,
          retryAction: APP_UPDATE_ACTION.CHECK,
        }),
        state: this.getState(),
      };
    } finally {
      this._endOperation(APP_UPDATE_ACTION.CHECK);
    }
  }

  async downloadUpdate() {
    if (this.disposed) {
      return { success: false, code: "APP_UPDATE_DISPOSED", state: this.getState() };
    }
    if (!this.state.enabled || !this.updater) {
      return { success: false, code: "APP_UPDATE_DISABLED", state: this.getState() };
    }
    if (this.activeOperation) return this._busyResult();

    const retryMismatch = this._retryMismatch(APP_UPDATE_ACTION.DOWNLOAD);
    if (retryMismatch) return retryMismatch;

    const isDownloadRetry =
      this.state.status === APP_UPDATE_STATUS.ERROR &&
      this.state.retryAction === APP_UPDATE_ACTION.DOWNLOAD;
    if (this.state.status !== APP_UPDATE_STATUS.AVAILABLE && !isDownloadRetry) {
      return {
        success: false,
        code: "APP_UPDATE_NOT_AVAILABLE",
        state: this.getState(),
      };
    }

    this._beginOperation(APP_UPDATE_ACTION.DOWNLOAD);

    this._setState({
      status: APP_UPDATE_STATUS.DOWNLOADING,
      progress: 0,
      bytesPerSecond: 0,
      transferred: 0,
      total: 0,
      error: null,
      retryAction: null,
      installBlockedReason: null,
    });

    try {
      await this.updater.downloadUpdate();
      if (this.state.status === APP_UPDATE_STATUS.DOWNLOADING) {
        this._setState({
          status: APP_UPDATE_STATUS.DOWNLOADED,
          progress: 100,
          downloadedAt: this._nowIso(),
          retryAction: null,
        });
      }

      if (
        this.state.status === APP_UPDATE_STATUS.ERROR &&
        this.state.error?.phase === APP_UPDATE_ACTION.DOWNLOAD
      ) {
        return {
          success: false,
          code: "APP_UPDATE_DOWNLOAD_FAILED",
          error: clone(this.state.error),
          state: this.getState(),
        };
      }
      return { success: true, state: this.getState() };
    } catch (error) {
      this._handleError(error, APP_UPDATE_ACTION.DOWNLOAD);
      return {
        success: false,
        code: "APP_UPDATE_DOWNLOAD_FAILED",
        error: normalizeUpdaterError(error, {
          phase: APP_UPDATE_ACTION.DOWNLOAD,
          retryAction: APP_UPDATE_ACTION.DOWNLOAD,
        }),
        state: this.getState(),
      };
    } finally {
      this._endOperation(APP_UPDATE_ACTION.DOWNLOAD);
    }
  }

  async installUpdate(canInstall = () => ({ allowed: true })) {
    if (this.disposed) {
      return { success: false, code: "APP_UPDATE_DISPOSED", state: this.getState() };
    }
    if (!this.state.enabled || !this.updater) {
      return { success: false, code: "APP_UPDATE_DISABLED", state: this.getState() };
    }
    if (this.activeOperation) return this._busyResult();

    const retryMismatch = this._retryMismatch(APP_UPDATE_ACTION.INSTALL);
    if (retryMismatch) return retryMismatch;

    const isInstallRetry =
      this.state.status === APP_UPDATE_STATUS.ERROR &&
      this.state.retryAction === APP_UPDATE_ACTION.INSTALL;
    if (this.state.status !== APP_UPDATE_STATUS.DOWNLOADED && !isInstallRetry) {
      return {
        success: false,
        code: "APP_UPDATE_NOT_DOWNLOADED",
        state: this.getState(),
      };
    }

    this._beginOperation(APP_UPDATE_ACTION.INSTALL);
    try {
      const readiness = (await canInstall()) || {};
      if (!readiness.allowed) {
        const reason = toNullableString(readiness.reason) ||
          "当前仍有任务或服务运行，暂不能安装更新。";
        this._setState({
          status: APP_UPDATE_STATUS.DOWNLOADED,
          error: null,
          retryAction: null,
          installBlockedReason: reason,
        });
        return {
          success: false,
          code: "APP_UPDATE_INSTALL_BLOCKED",
          reason,
          readiness,
          state: this.getState(),
        };
      }

      this._setState({
        installBlockedReason: null,
        status: APP_UPDATE_STATUS.INSTALLING,
        error: null,
        retryAction: null,
      });
      await this.updater.quitAndInstall(false, true);
      if (
        this.state.status === APP_UPDATE_STATUS.ERROR &&
        this.state.error?.phase === APP_UPDATE_ACTION.INSTALL
      ) {
        return {
          success: false,
          code: "APP_UPDATE_INSTALL_FAILED",
          error: clone(this.state.error),
          state: this.getState(),
        };
      }
      return { success: true, state: this.getState() };
    } catch (error) {
      this._handleError(error, APP_UPDATE_ACTION.INSTALL);
      return {
        success: false,
        code: "APP_UPDATE_INSTALL_FAILED",
        error: normalizeUpdaterError(error, {
          phase: APP_UPDATE_ACTION.INSTALL,
          retryAction: APP_UPDATE_ACTION.INSTALL,
        }),
        state: this.getState(),
      };
    } finally {
      this._endOperation(APP_UPDATE_ACTION.INSTALL);
    }
  }

  _setState(patch) {
    if (this.disposed) return false;
    this.state = { ...this.state, ...patch };
    try {
      this.send(this.getState());
    } catch {
      // Renderer delivery must not corrupt the provider-facing state machine.
    }
    return true;
  }

  _handleChecking() {
    if (
      this.disposed ||
      this.activeOperation !== APP_UPDATE_ACTION.CHECK ||
      this._isProtectedFromCheck()
    ) {
      return false;
    }
    return this._setState({
      status: APP_UPDATE_STATUS.CHECKING,
      error: null,
      retryAction: null,
      installBlockedReason: null,
    });
  }

  _handleAvailable(info) {
    if (
      this.disposed ||
      this.activeOperation !== APP_UPDATE_ACTION.CHECK ||
      this.state.status !== APP_UPDATE_STATUS.CHECKING
    ) {
      return false;
    }
    const version = getUpdateVersion(info);
    return this._setState({
      status: APP_UPDATE_STATUS.AVAILABLE,
      availableVersion: version,
      latestVersion: version,
      releaseName: toNullableString(info.releaseName),
      releaseDate: toNullableString(info.releaseDate),
      releaseNotes: getReleaseNotes(info),
      checkedAt: this._nowIso(),
      error: null,
      retryAction: null,
      installBlockedReason: null,
    });
  }

  _handleNotAvailable(info) {
    if (
      this.disposed ||
      this.activeOperation !== APP_UPDATE_ACTION.CHECK ||
      this.state.status !== APP_UPDATE_STATUS.CHECKING
    ) {
      return false;
    }
    return this._setState({
      status: APP_UPDATE_STATUS.UP_TO_DATE,
      availableVersion: null,
      latestVersion: getUpdateVersion(info),
      releaseName: null,
      releaseDate: null,
      releaseNotes: null,
      checkedAt: this._nowIso(),
      error: null,
      retryAction: null,
      installBlockedReason: null,
    });
  }

  _handleProgress(progress) {
    if (
      this.disposed ||
      this.activeOperation !== APP_UPDATE_ACTION.DOWNLOAD ||
      this.state.status !== APP_UPDATE_STATUS.DOWNLOADING
    ) {
      return false;
    }
    return this._setState({
      status: APP_UPDATE_STATUS.DOWNLOADING,
      ...getProgressState(progress),
      error: null,
      retryAction: null,
    });
  }

  _handleDownloaded(info) {
    if (
      this.disposed ||
      this.activeOperation !== APP_UPDATE_ACTION.DOWNLOAD ||
      this.state.status !== APP_UPDATE_STATUS.DOWNLOADING
    ) {
      return false;
    }
    const version = getUpdateVersion(info) || this.state.availableVersion;
    return this._setState({
      status: APP_UPDATE_STATUS.DOWNLOADED,
      availableVersion: version,
      latestVersion: version || this.state.latestVersion,
      progress: 100,
      downloadedAt: this._nowIso(),
      error: null,
      retryAction: null,
      installBlockedReason: null,
    });
  }

  _handleError(error, phase = this.activeOperation) {
    const normalizedPhase = normalizeAction(phase);
    if (this.disposed || !normalizedPhase) {
      return false;
    }

    const retryAction = normalizedPhase;
    const patch = {
      status: APP_UPDATE_STATUS.ERROR,
      error: normalizeUpdaterError(error, {
        phase: normalizedPhase,
        retryAction,
      }),
      retryAction,
      installBlockedReason: null,
    };
    if (normalizedPhase === APP_UPDATE_ACTION.CHECK) {
      patch.checkedAt = this._nowIso();
    }
    return this._setState(patch);
  }
}

export { DEFAULT_INITIAL_CHECK_DELAY_MS };
