import {
  assertSafeRelativePath,
  MANIFEST_KEY_ID,
  verifySignedManifest,
} from "../runtime/manifest-verifier.js";
import {
  buildSourceUrl,
  classifyHttpStatus,
  classifySourceError,
  ReleaseSourceError,
  ReleaseSourcePool,
  SOURCE_ERROR_KIND,
} from "../runtime/release-source.js";
import { normalizeAppUpdateChannel } from "./update-channel.js";
import { resolveAppEdition } from "./edition.js";

const DEFAULT_MANIFEST_PATH = (channel) => `manifests/${channel}/latest.json`;
const DEFAULT_TIMEOUT_MS = 30_000;

export class AppManifestGuardError extends Error {
  constructor(message, code = "APP_MANIFEST_INVALID", details = {}) {
    super(message);
    this.name = "AppManifestGuardError";
    this.code = code;
    this.details = details;
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createRequestSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const forward = () => controller.abort(signal.reason || new DOMException("Operation aborted", "AbortError"));
  if (signal?.aborted) forward();
  else signal?.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forward);
    },
  };
}

function normalizeGuardError(error, sourceId) {
  if (error instanceof AppManifestGuardError) {
    const wrapped = new ReleaseSourceError(error.message, {
      kind: SOURCE_ERROR_KIND.INTEGRITY,
      sourceId,
      cause: error,
    });
    wrapped.code = error.code;
    return wrapped;
  }
  if (error?.code?.startsWith?.("MANIFEST_")) {
    const wrapped = new ReleaseSourceError(error.message, {
      kind: SOURCE_ERROR_KIND.INTEGRITY,
      sourceId,
      cause: error,
    });
    wrapped.code = error.code;
    return wrapped;
  }
  return classifySourceError(error, sourceId);
}

function updateVersion(updateInfo) {
  return String(updateInfo?.version || updateInfo?.versionInfo?.version || "").trim();
}

export class AppManifestGuard {
  constructor(options = {}) {
    this.sources = options.sources || [];
    this.sourcePool = options.sourcePool || (this.sources.length ? new ReleaseSourcePool({ sources: this.sources }) : null);
    this.publicKeys = options.publicKeys || {};
    this.expectedKeyId = options.expectedKeyId || MANIFEST_KEY_ID;
    this.channel = normalizeAppUpdateChannel(options.channel);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.platform = options.platform || process.platform;
    this.arch = options.arch || (process.arch === "ia32" ? "ia32" : "x64");
    this.manifestPath = options.manifestPath || DEFAULT_MANIFEST_PATH;
    this.timeoutMs = Math.max(1_000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.now = options.now || (() => Date.now());
    this.minimumSequence = options.minimumSequence;
    this.lastVerified = null;
  }

  get enabled() {
    const hasKeys = this.publicKeys instanceof Map ? this.publicKeys.size > 0 : Object.keys(this.publicKeys).length > 0;
    return Boolean(this.sourcePool && hasKeys && typeof this.fetchImpl === "function");
  }

  setChannel(channel) {
    const normalized = normalizeAppUpdateChannel(channel);
    if (normalized !== this.channel) {
      this.channel = normalized;
      this.lastVerified = null;
      this.minimumSequence = undefined;
    }
    return this.getState();
  }

  async preflight({ channel = this.channel, signal } = {}) {
    if (!this.enabled) return { enabled: false, verified: false, manifest: null };
    const relativePath = assertSafeRelativePath(this.manifestPath(channel), "app manifest path");
    const { result, source } = await this.sourcePool.run(async (candidate) => {
      const request = createRequestSignal(signal, this.timeoutMs);
      try {
        const response = await this.fetchImpl(buildSourceUrl(candidate, relativePath), {
          method: "GET",
          cache: "no-store",
          signal: request.signal,
        });
        if (!response.ok) throw classifyHttpStatus(response.status, candidate.id);
        const body = await response.text();
        try {
          return verifySignedManifest(body, {
            publicKeys: this.publicKeys,
            expectedKeyId: this.expectedKeyId,
            expectedChannel: channel,
            expectedPlatform: this.platform,
            expectedArch: this.arch,
            minimumSequence: this.minimumSequence,
            now: this.now(),
          });
        } catch (error) {
          throw normalizeGuardError(error, candidate.id);
        }
      } catch (error) {
        if (signal?.aborted) {
          throw new ReleaseSourceError("App manifest preflight was cancelled", {
            kind: SOURCE_ERROR_KIND.CANCELLED,
            sourceId: candidate.id,
            cause: error,
          });
        }
        throw normalizeGuardError(error, candidate.id);
      } finally {
        request.cleanup();
      }
    });
    if (!result.payload.app) {
      throw new AppManifestGuardError("Signed app manifest does not contain app metadata", "APP_MANIFEST_APP_SECTION_MISSING");
    }
    const edition = resolveAppEdition(result.payload.appVersion);
    if (result.payload.edition !== edition.edition || result.payload.appId !== edition.appId) {
      throw new AppManifestGuardError(
        "Signed app manifest identity does not match its application version",
        "APP_MANIFEST_EDITION_MISMATCH",
      );
    }
    this.lastVerified = { ...result, sourceId: source.id };
    this.minimumSequence = result.sequence;
    return { enabled: true, verified: true, manifest: clone(this.lastVerified) };
  }

  validateUpdateInfo(updateInfo) {
    if (!this.enabled) return { valid: true, enabled: false, manifest: null };
    const verified = this.lastVerified;
    if (!verified) {
      throw new AppManifestGuardError("App update was not preceded by a signed manifest preflight", "APP_MANIFEST_PREFLIGHT_REQUIRED");
    }
    const version = updateVersion(updateInfo);
    if (!version || version !== verified.payload.appVersion) {
      throw new AppManifestGuardError("electron-updater version does not match the signed app manifest", "APP_MANIFEST_VERSION_MISMATCH", {
        expected: verified.payload.appVersion,
        actual: version,
      });
    }
    const files = Array.isArray(updateInfo?.files) ? updateInfo.files : [];
    const installer = files.find((file) => String(file?.url || "").toLowerCase().endsWith(".exe")) || files[0];
    if (verified.payload.app.installerSha512 && installer?.sha512 && installer.sha512 !== verified.payload.app.installerSha512) {
      throw new AppManifestGuardError("electron-updater installer hash does not match the signed app manifest", "APP_MANIFEST_INSTALLER_HASH_MISMATCH");
    }
    return { valid: true, enabled: true, manifest: clone(verified), version };
  }

  getState() {
    return {
      enabled: this.enabled,
      channel: this.channel,
      sourceId: this.lastVerified?.sourceId || null,
      sequence: this.lastVerified?.sequence || null,
      appVersion: this.lastVerified?.payload?.appVersion || null,
    };
  }
}

export { DEFAULT_MANIFEST_PATH, DEFAULT_TIMEOUT_MS };
