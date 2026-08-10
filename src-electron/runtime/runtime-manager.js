import fs from "node:fs/promises";
import path from "node:path";

import {
  assertSafeRelativePath,
  MANIFEST_CHANNELS,
  MANIFEST_KEY_ID,
  verifySignedManifest,
} from "./manifest-verifier.js";
import {
  downloadArtifact,
  extractZipSafely,
} from "./asset-downloader.js";
import {
  buildSourceUrl,
  classifyHttpStatus,
  classifySourceError,
  ReleaseSourceError,
  ReleaseSourcePool,
  SOURCE_ERROR_KIND,
} from "./release-source.js";
import { probeManagedComponent } from "./component-probe.js";
import {
  COMPONENT_IDS,
  createRuntimeLayout,
  ensureRuntimeDirectories,
  readJson,
  resolveComponentDirectory,
  resolveDownloadPaths,
  resolveStagingDirectory,
  writeActivePointer,
  writeJsonAtomic,
  writeVerifiedManifest,
} from "./runtime-layout.js";

const DEFAULT_MANIFEST_PATH = (channel) => `components/win-x64/${channel}/manifest.json`;
const DEFAULT_MANIFEST_TIMEOUT_MS = 30_000;
const DEFAULT_COMPONENT_PROBE_TIMEOUT_MS = 30_000;
const ACCELERATORS = Object.freeze(["cpu", "cu130"]);
const COMPONENT_RECEIPT_FILE = ".moonshine-component.json";

export const RUNTIME_STATUS = Object.freeze({
  DISABLED: "disabled",
  IDLE: "idle",
  CHECKING: "checking",
  READY: "ready",
  NEEDS_DOWNLOAD: "needs-download",
  DOWNLOADING: "downloading",
  VERIFYING: "verifying",
  FAILED: "failed",
  ROLLING_BACK: "rolling-back",
});

export class RuntimeManagerError extends Error {
  constructor(message, code = "RUNTIME_MANAGER_FAILED", details = {}) {
    super(message);
    this.name = "RuntimeManagerError";
    this.code = code;
    this.details = details;
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeAccelerator(value) {
  const accelerator = String(value ?? "").trim().toLowerCase();
  if (!ACCELERATORS.includes(accelerator)) {
    throw new RuntimeManagerError(`Unsupported accelerator: ${accelerator}`, "RUNTIME_ACCELERATOR_UNSUPPORTED");
  }
  return accelerator;
}

function componentIdForAccelerator(accelerator) {
  return accelerator === "cpu" ? COMPONENT_IDS.PYTHON_CPU : COMPONENT_IDS.PYTHON_CU130;
}

function defaultManifestPath(channel) {
  return DEFAULT_MANIFEST_PATH(channel);
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR" || error?.code === "ASSET_DOWNLOAD_CANCELLED";
}

function componentEntrypointPath(componentRoot, entrypoint, fallback) {
  const relative = assertSafeRelativePath(entrypoint || fallback, "component.entrypoint");
  const target = path.resolve(componentRoot, relative);
  const relativeToRoot = path.relative(path.resolve(componentRoot), target);
  if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
    throw new RuntimeManagerError("Component entrypoint escapes its root", "RUNTIME_PATH_TRAVERSAL");
  }
  return target;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readResponseText(response, sourceId) {
  if (!response.ok) throw classifyHttpStatus(response.status, sourceId);
  try {
    return await response.text();
  } catch (error) {
    throw new ReleaseSourceError("Failed to read the signed runtime manifest", {
      kind: SOURCE_ERROR_KIND.NETWORK,
      sourceId,
      cause: error,
    });
  }
}

function createAbortSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const forward = () => controller.abort(signal.reason || new DOMException("Operation aborted", "AbortError"));
  if (signal?.aborted) forward();
  else signal?.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forward);
    },
  };
}

function normalizeSourceError(error, sourceId) {
  if (error instanceof RuntimeManagerError) {
    return new ReleaseSourceError(error.message, {
      kind: SOURCE_ERROR_KIND.CONFIGURATION,
      sourceId,
      cause: error,
    });
  }
  if (error?.code?.startsWith?.("MANIFEST_")) {
    const wrapped = new ReleaseSourceError(error.message, {
      kind: SOURCE_ERROR_KIND.INTEGRITY,
      sourceId,
      cause: error,
    });
    wrapped.code = error.code;
    wrapped.retryable = true;
    return wrapped;
  }
  return classifySourceError(error, sourceId);
}

export class RuntimeManager {
  constructor(options = {}) {
    this.layout = options.layout || createRuntimeLayout({
      localAppData: options.localAppData,
      userData: options.userData,
      env: options.env,
    });
    this.sources = options.sources || [];
    this.sourcePool = options.sourcePool || (this.sources.length ? new ReleaseSourcePool({ sources: this.sources }) : null);
    this.publicKeys = options.publicKeys || new Map();
    this.expectedKeyId = options.expectedKeyId || MANIFEST_KEY_ID;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.downloadImpl = options.downloadImpl || downloadArtifact;
    this.extractImpl = options.extractImpl || extractZipSafely;
    this.runComponentProcess = options.runComponentProcess;
    this.probeComponent = options.probeComponent || this._defaultProbeComponent.bind(this);
    this.now = options.now || (() => Date.now());
    this.platform = options.platform || process.platform;
    this.arch = options.arch || (process.arch === "ia32" ? "ia32" : "x64");
    this.appVersion = options.appVersion || "";
    this.channelPreferences = options.channelPreferences || this.layout.channelPreferences;
    this.manifestPath = options.manifestPath || defaultManifestPath;
    this.manifestTimeoutMs = Math.max(1_000, Number(options.manifestTimeoutMs) || DEFAULT_MANIFEST_TIMEOUT_MS);
    this.componentProbeTimeoutMs = Math.max(1_000, Number(options.componentProbeTimeoutMs) || DEFAULT_COMPONENT_PROBE_TIMEOUT_MS);
    this.canActivate = typeof options.canActivate === "function" ? options.canActivate : async () => true;
    this.onState = typeof options.onState === "function" ? options.onState : () => {};
    this.channel = options.channel || "stable";
    if (!MANIFEST_CHANNELS.includes(this.channel)) {
      throw new RuntimeManagerError(`Unsupported runtime channel: ${this.channel}`, "RUNTIME_CHANNEL_UNSUPPORTED");
    }
    this.operation = null;
    this.state = {
      enabled: this.sources.length > 0 && this.publicKeys &&
        (this.publicKeys instanceof Map ? this.publicKeys.size > 0 : Object.keys(this.publicKeys).length > 0),
      channel: this.channel,
      status: RUNTIME_STATUS.IDLE,
      selectedAccelerator: null,
      manifestSequence: null,
      availableComponents: [],
      activeComponents: {},
      lastSourceId: null,
      checkedAt: null,
      updatedAt: null,
      progress: null,
      error: null,
    };
  }

  getState() {
    return clone(this.state);
  }

  async initialize() {
    const stored = await readJson(this.channelPreferences, { defaultValue: null });
    const pointer = await readJson(this.layout.activePointer, { defaultValue: null });
    const activeComponents = this._activeComponents(pointer);
    const selectedAccelerator = activeComponents[COMPONENT_IDS.PYTHON_CU130]
      ? "cu130"
      : activeComponents[COMPONENT_IDS.PYTHON_CPU]
        ? "cpu"
        : null;
    const storedChannel = String(stored?.channel || "").trim().toLowerCase();
    if (MANIFEST_CHANNELS.includes(storedChannel)) {
      this.channel = storedChannel;
    }
    this._setState({
      channel: this.channel,
      activeComponents,
      selectedAccelerator,
    });
    return this.getState();
  }

  _setState(patch) {
    this.state = { ...this.state, ...patch };
    try {
      this.onState(this.getState());
    } catch {
      // A renderer observer must not affect runtime state.
    }
  }

  _begin(operation) {
    if (this.operation) {
      return new RuntimeManagerError("Another runtime operation is already running", "RUNTIME_BUSY", {
        operation: this.operation,
      });
    }
    this.operation = operation;
    return null;
  }

  _end(operation) {
    if (this.operation === operation) this.operation = null;
  }

  async setChannel(channel) {
    const normalized = String(channel ?? "").trim().toLowerCase();
    if (!MANIFEST_CHANNELS.includes(normalized)) {
      return { success: false, code: "RUNTIME_CHANNEL_UNSUPPORTED", state: this.getState() };
    }
    if (this.operation) return { success: false, code: "RUNTIME_BUSY", state: this.getState() };
    this.channel = normalized;
    await writeJsonAtomic(this.channelPreferences, {
      schemaVersion: 1,
      channel: normalized,
      updatedAt: new Date(this.now()).toISOString(),
    });
    this._setState({ channel: normalized, manifestSequence: null, availableComponents: [], error: null });
    return { success: true, channel: normalized, state: this.getState() };
  }

  async _fetchManifest(channel, signal) {
    await ensureRuntimeDirectories(this.layout);
    if (!this.sourcePool) {
      throw new RuntimeManagerError("No runtime release source is configured", "RUNTIME_SOURCE_UNAVAILABLE");
    }
    if (typeof this.fetchImpl !== "function") {
      throw new RuntimeManagerError("A Fetch API implementation is required", "RUNTIME_FETCH_UNAVAILABLE");
    }
    const manifestPath = assertSafeRelativePath(this.manifestPath(channel), "runtime manifest path");
    const cached = await readJson(this.layout.verifiedManifest, { defaultValue: null });
    const minimumSequence = cached?.payload?.channel === channel ? cached.payload.sequence : undefined;
    const { result, source } = await this.sourcePool.run(async (candidate) => {
      const request = createAbortSignal(signal, this.manifestTimeoutMs);
      try {
        const response = await this.fetchImpl(buildSourceUrl(candidate, manifestPath), {
          method: "GET",
          cache: "no-store",
          signal: request.signal,
        });
        const text = await readResponseText(response, candidate.id);
        let verified;
        try {
          verified = verifySignedManifest(text, {
            publicKeys: this.publicKeys,
            expectedKeyId: this.expectedKeyId,
            expectedChannel: channel,
            expectedPlatform: this.platform,
            expectedArch: this.arch,
            expectedAppVersion: this.appVersion || undefined,
            minimumSequence,
            now: this.now(),
          });
        } catch (error) {
          throw normalizeSourceError(error, candidate.id);
        }
        return verified;
      } catch (error) {
        if (signal?.aborted || request.signal.aborted && signal?.aborted) {
          throw new ReleaseSourceError("Runtime manifest request was cancelled", {
            kind: SOURCE_ERROR_KIND.CANCELLED,
            sourceId: candidate.id,
            cause: error,
          });
        }
        throw normalizeSourceError(error, candidate.id);
      } finally {
        request.cleanup();
      }
    }, {
      shouldFallback: (error) => error.kind === SOURCE_ERROR_KIND.NETWORK ||
        error.kind === SOURCE_ERROR_KIND.HTTP || error.kind === SOURCE_ERROR_KIND.INTEGRITY,
    });
    await writeVerifiedManifest(this.layout, result.manifest);
    return { ...result, sourceId: source.id, manifestPath };
  }

  _findComponents(payload, accelerator) {
    const pythonId = componentIdForAccelerator(accelerator);
    const components = Array.isArray(payload.components) ? payload.components : [];
    const selected = components.filter((component) => component.id === pythonId || component.id === COMPONENT_IDS.FFMPEG);
    if (!selected.some((component) => component.id === pythonId)) {
      throw new RuntimeManagerError(`Runtime manifest does not provide ${pythonId}`, "RUNTIME_COMPONENT_MISSING");
    }
    if (!selected.some((component) => component.id === COMPONENT_IDS.FFMPEG)) {
      throw new RuntimeManagerError("Runtime manifest does not provide ffmpeg", "RUNTIME_COMPONENT_MISSING");
    }
    return selected;
  }

  _activeComponents(pointer) {
    return pointer && typeof pointer === "object" && pointer.components && typeof pointer.components === "object"
      ? pointer.components
      : {};
  }

  _componentSnapshots(pointer, componentId) {
    const snapshots = [this._activeComponents(pointer), ...(Array.isArray(pointer?.history) ? pointer.history : [])];
    return snapshots
      .map((snapshot) => snapshot && typeof snapshot === "object" ? snapshot[componentId] : null)
      .filter((component) => component && typeof component === "object");
  }

  _assertNoVersionCollision(component, pointer) {
    const collision = this._componentSnapshots(pointer, component.id).find((candidate) =>
      candidate.version === component.version && candidate.sha256 && candidate.sha256 !== component.sha256
    );
    if (!collision) return;
    throw new RuntimeManagerError(
      `Component ${component.id} version ${component.version} is already associated with different bytes`,
      "RUNTIME_COMPONENT_VERSION_COLLISION",
      {
        componentId: component.id,
        version: component.version,
        installedSha256: collision.sha256,
        manifestSha256: component.sha256,
      },
    );
  }

  async _componentIsInstalled(component, signal) {
    const root = resolveComponentDirectory(this.layout, component.id, component.version);
    if (!(await pathExists(root))) return null;
    const receipt = await readJson(path.join(root, COMPONENT_RECEIPT_FILE), { defaultValue: null }).catch(() => null);
    if (!receipt || receipt.schemaVersion !== 1 || receipt.id !== component.id || receipt.version !== component.version) {
      return null;
    }
    if (receipt.sha256 !== component.sha256) {
      throw new RuntimeManagerError(
        `Component ${component.id} version ${component.version} is already installed with different bytes`,
        "RUNTIME_COMPONENT_VERSION_COLLISION",
        {
          componentId: component.id,
          version: component.version,
          installedSha256: receipt.sha256 || null,
          manifestSha256: component.sha256,
        },
      );
    }
    try {
      const probe = await this._probe(component, root, signal);
      return {
        id: component.id,
        version: component.version,
        sha256: component.sha256,
        root,
        entrypoint: probe.entrypoint || receipt.entrypoint || component.entrypoint || null,
      };
    } catch {
      return null;
    }
  }

  async _defaultProbeComponent(component, root, { signal } = {}) {
    return await probeManagedComponent({
      component,
      root,
      signal,
      timeoutMs: this.componentProbeTimeoutMs,
      runProcessImpl: this.runComponentProcess,
      platform: this.platform,
    });
  }

  async _probe(component, root, signal) {
    if (signal?.aborted) throw new RuntimeManagerError("Runtime operation was cancelled", "RUNTIME_CANCELLED");
    const timeout = createAbortSignal(signal, this.componentProbeTimeoutMs);
    try {
      let result;
      try {
        result = await this.probeComponent(component, root, { signal: timeout.signal });
      } catch (error) {
        if (signal?.aborted) {
          throw new RuntimeManagerError("Runtime operation was cancelled", "RUNTIME_CANCELLED", { cause: error });
        }
        throw new RuntimeManagerError(
          error?.message || `Component ${component.id} failed its health check`,
          "RUNTIME_COMPONENT_UNHEALTHY",
          { cause: error },
        );
      }
      if (result === true) return { success: true };
      if (!result?.success) {
        throw new RuntimeManagerError(result?.error || `Component ${component.id} failed its health check`, "RUNTIME_COMPONENT_UNHEALTHY");
      }
      return result;
    } finally {
      timeout.cleanup();
    }
  }

  async _componentIsActive(component, pointer, signal) {
    const active = this._activeComponents(pointer)[component.id];
    if (!active || active.version !== component.version || active.sha256 !== component.sha256) return null;
    const root = resolveComponentDirectory(this.layout, component.id, component.version);
    if (!(await pathExists(root))) return null;
    try {
      const probe = await this._probe(component, root, signal);
      return { ...active, root, entrypoint: probe.entrypoint || active.entrypoint };
    } catch {
      return null;
    }
  }

  async check({ channel = this.channel, signal } = {}) {
    const busy = this._begin("check");
    if (busy) return { success: false, code: busy.code, state: this.getState() };
    this._setState({ status: RUNTIME_STATUS.CHECKING, error: null, channel });
    try {
      const verified = await this._fetchManifest(channel, signal);
      const pointer = await readJson(this.layout.activePointer, { defaultValue: null });
      const active = this._activeComponents(pointer);
      const availableComponents = Array.isArray(verified.payload.components)
        ? verified.payload.components.map((component) => ({
          id: component.id,
          version: component.version,
          size: component.size,
          sha256: component.sha256,
          active: active[component.id]?.version === component.version && active[component.id]?.sha256 === component.sha256,
        }))
        : [];
      const activeComponents = Object.fromEntries(Object.entries(active).map(([id, value]) => [id, { ...value }]));
      const hasMissingComponents = availableComponents.some((component) => !component.active);
      this._setState({
        status: hasMissingComponents ? RUNTIME_STATUS.NEEDS_DOWNLOAD : RUNTIME_STATUS.READY,
        manifestSequence: verified.sequence,
        availableComponents,
        activeComponents,
        lastSourceId: verified.sourceId,
        checkedAt: new Date(this.now()).toISOString(),
      });
      return { success: true, manifest: verified, state: this.getState() };
    } catch (error) {
      const normalized = error instanceof RuntimeManagerError ? error : normalizeSourceError(error);
      this._setState({ status: RUNTIME_STATUS.FAILED, error: { code: normalized.code || normalized.name, message: normalized.message } });
      return { success: false, code: normalized.code || "RUNTIME_CHECK_FAILED", error: normalized.message, state: this.getState() };
    } finally {
      this._end("check");
    }
  }

  async ensure({ accelerator = "cpu", channel = this.channel, signal, onProgress } = {}) {
    const normalizedAccelerator = normalizeAccelerator(accelerator);
    const busy = this._begin("ensure");
    if (busy) return { success: false, code: busy.code, state: this.getState() };
    this._setState({ status: RUNTIME_STATUS.CHECKING, selectedAccelerator: normalizedAccelerator, error: null, channel });
    try {
      const verified = await this._fetchManifest(channel, signal);
      const components = this._findComponents(verified.payload, normalizedAccelerator);
      let pointer = await readJson(this.layout.activePointer, { defaultValue: null });
      const selected = {};
      const total = components.reduce((sum, component) => sum + component.size, 0);
      let completed = 0;
      for (const component of components) {
        if (signal?.aborted) throw new RuntimeManagerError("Runtime operation was cancelled", "RUNTIME_CANCELLED");
        this._assertNoVersionCollision(component, pointer);
        const current = await this._componentIsActive(component, pointer, signal);
        if (current) {
          selected[component.id] = current;
          completed += component.size;
          onProgress?.({ component: component.id, transferred: completed, total });
          continue;
        }
        const installed = await this._componentIsInstalled(component, signal);
        if (installed) {
          selected[component.id] = installed;
          completed += component.size;
          onProgress?.({ component: component.id, transferred: completed, total });
          continue;
        }

        this._setState({ status: RUNTIME_STATUS.DOWNLOADING, progress: { component: component.id, transferred: completed, total } });
        const paths = resolveDownloadPaths(this.layout, component);
        const download = await this.downloadImpl({
          artifact: component,
          paths,
          sourcePool: this.sourcePool,
          signal,
          onProgress: (progress) => onProgress?.({ component: component.id, ...progress, transferred: completed + progress.transferred, total }),
        });
        this._setState({ status: RUNTIME_STATUS.VERIFYING });
        const operationId = `runtime-${verified.sequence}-${Date.now()}`;
        let staging = resolveStagingDirectory(this.layout, operationId, component.id);
        let probe;
        const target = resolveComponentDirectory(this.layout, component.id, component.version);
        try {
          await this.extractImpl({ archivePath: download.path, destination: staging });
          probe = await this._probe(component, staging, signal);
          await writeJsonAtomic(path.join(staging, COMPONENT_RECEIPT_FILE), {
            schemaVersion: 1,
            id: component.id,
            version: component.version,
            sha256: component.sha256,
            entrypoint: probe.entrypoint || component.entrypoint || null,
            installedAt: new Date(this.now()).toISOString(),
          });
          if (await pathExists(target)) {
            const active = this._activeComponents(pointer)[component.id];
            const replacingActive = active?.version === component.version && active?.sha256 === component.sha256;
            if (replacingActive && !(await this.canActivate({ accelerator: normalizedAccelerator, components, signal }))) {
              throw new RuntimeManagerError("Backend is still running; active runtime repair is blocked", "RUNTIME_ACTIVATION_BLOCKED");
            }
            await fs.rm(target, { recursive: true, force: true });
          }
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.rename(staging, target);
          staging = null;
        } finally {
          if (staging) await fs.rm(staging, { recursive: true, force: true });
        }
        selected[component.id] = {
          id: component.id,
          version: component.version,
          sha256: component.sha256,
          root: target,
          entrypoint: probe.entrypoint || component.entrypoint || null,
        };
        completed += component.size;
        onProgress?.({ component: component.id, transferred: completed, total });
      }

      if (!(await this.canActivate({ accelerator: normalizedAccelerator, components, signal }))) {
        throw new RuntimeManagerError("Backend is still running; runtime activation is blocked", "RUNTIME_ACTIVATION_BLOCKED");
      }
      const nextPointer = {
        schemaVersion: 1,
        channel,
        accelerator: normalizedAccelerator,
        manifestSequence: verified.sequence,
        updatedAt: new Date(this.now()).toISOString(),
        components: selected,
        history: pointer?.components ? [{ ...pointer.components }, ...(pointer.history || [])].slice(0, 2) : [],
      };
      await writeActivePointer(this.layout, nextPointer);
      pointer = nextPointer;
      this._setState({
        status: RUNTIME_STATUS.READY,
        manifestSequence: verified.sequence,
        activeComponents: selected,
        availableComponents: components.map((component) => ({ id: component.id, version: component.version, size: component.size, sha256: component.sha256, active: true })),
        lastSourceId: this.sourcePool.orderedSources()[0]?.id || null,
        updatedAt: nextPointer.updatedAt,
        progress: null,
      });
      return { success: true, accelerator: normalizedAccelerator, components: selected, pointer, manifest: verified, state: this.getState() };
    } catch (error) {
      const normalized = error instanceof RuntimeManagerError || error instanceof ReleaseSourceError
        ? error
        : normalizeSourceError(error);
      const code = isAbortError(error) ? "RUNTIME_CANCELLED" : normalized.code || "RUNTIME_ENSURE_FAILED";
      this._setState({ status: code === "RUNTIME_CANCELLED" ? RUNTIME_STATUS.IDLE : RUNTIME_STATUS.FAILED, error: { code, message: normalized.message }, progress: null });
      return { success: false, code, error: normalized.message, state: this.getState() };
    } finally {
      this._end("ensure");
    }
  }

  async rollback() {
    const busy = this._begin("rollback");
    if (busy) return { success: false, code: busy.code, state: this.getState() };
    this._setState({ status: RUNTIME_STATUS.ROLLING_BACK, error: null });
    try {
      const pointer = await readJson(this.layout.activePointer, { defaultValue: null });
      const previous = pointer?.history?.[0];
      if (!previous || typeof previous !== "object") {
        return { success: false, code: "RUNTIME_NO_ROLLBACK", state: this.getState() };
      }
      for (const component of Object.values(previous)) {
        const root = resolveComponentDirectory(this.layout, component.id, component.version);
        if (!(await pathExists(root))) throw new RuntimeManagerError("Rollback component is missing", "RUNTIME_ROLLBACK_UNAVAILABLE");
        await this._probe({ ...component, entrypoint: component.entrypoint }, root);
      }
      const selectedAccelerator = previous[COMPONENT_IDS.PYTHON_CU130] ? "cu130" : "cpu";
      const next = {
        ...pointer,
        accelerator: selectedAccelerator,
        components: previous,
        history: pointer.history.slice(1),
        updatedAt: new Date(this.now()).toISOString(),
      };
      await writeActivePointer(this.layout, next);
      this._setState({ status: RUNTIME_STATUS.READY, activeComponents: previous, selectedAccelerator, updatedAt: next.updatedAt });
      return { success: true, pointer: next, state: this.getState() };
    } catch (error) {
      this._setState({ status: RUNTIME_STATUS.FAILED, error: { code: error.code || "RUNTIME_ROLLBACK_FAILED", message: error.message } });
      return { success: false, code: error.code || "RUNTIME_ROLLBACK_FAILED", error: error.message, state: this.getState() };
    } finally {
      this._end("rollback");
    }
  }

  getActiveBackendSpec() {
    const active = this._activeComponents(this.state.activeComponents ? { components: this.state.activeComponents } : null);
    const selectedId = this.state.selectedAccelerator
      ? componentIdForAccelerator(this.state.selectedAccelerator)
      : active[COMPONENT_IDS.PYTHON_CU130]
        ? COMPONENT_IDS.PYTHON_CU130
        : COMPONENT_IDS.PYTHON_CPU;
    const python = active[selectedId];
    const ffmpeg = active[COMPONENT_IDS.FFMPEG];
    return {
      pythonRoot: python?.root || null,
      pythonExecutable: python?.root && componentEntrypointPath(python.root, python.entrypoint, "python.exe"),
      ffmpegRoot: ffmpeg?.root || null,
      ffmpegExecutable: ffmpeg?.root && componentEntrypointPath(ffmpeg.root, ffmpeg.entrypoint, "ffmpeg.exe"),
    };
  }
}

export {
  ACCELERATORS,
  DEFAULT_MANIFEST_PATH,
};
