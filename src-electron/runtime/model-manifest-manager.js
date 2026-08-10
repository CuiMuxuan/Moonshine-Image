import fs from "node:fs/promises";

import {
  assertSafeRelativePath,
  MANIFEST_CHANNELS,
  MANIFEST_KEY_ID,
  verifySignedManifest,
} from "./manifest-verifier.js";
import {
  ensureRuntimeDirectories,
  readJson,
  writeJsonAtomic,
} from "./runtime-layout.js";
import {
  buildSourceUrl,
  classifyHttpStatus,
  ReleaseSourcePool,
  SOURCE_ERROR_KIND,
} from "./release-source.js";

const DEFAULT_MANIFEST_PATH = (channel) => `models/${channel}/manifest.json`;
const DEFAULT_TIMEOUT_MS = 30_000;

export const MODEL_MANIFEST_STATUS = Object.freeze({
  DISABLED: "disabled",
  IDLE: "idle",
  CHECKING: "checking",
  READY: "ready",
  FALLBACK: "fallback",
  FAILED: "failed",
});

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createAbortSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Model manifest request timed out")), timeoutMs);
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

async function responseText(response, sourceId) {
  if (!response?.ok) throw classifyHttpStatus(response?.status || 0, sourceId);
  return response.text();
}

export class ModelManifestManager {
  constructor(options = {}) {
    this.layout = options.layout;
    if (!this.layout?.verifiedModelManifest) {
      throw new Error("ModelManifestManager requires a runtime layout");
    }
    this.sources = options.sources || [];
    this.sourcePool = options.sourcePool || (this.sources.length ? new ReleaseSourcePool({ sources: this.sources }) : null);
    this.publicKeys = options.publicKeys || {};
    this.expectedKeyId = options.expectedKeyId || MANIFEST_KEY_ID;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.appVersion = options.appVersion || "";
    this.platform = options.platform || process.platform;
    this.arch = options.arch || (process.arch === "ia32" ? "ia32" : "x64");
    this.channel = options.channel || "stable";
    this.manifestPath = options.manifestPath || DEFAULT_MANIFEST_PATH;
    this.timeoutMs = Math.max(1_000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.now = options.now || (() => Date.now());
    this.onState = typeof options.onState === "function" ? options.onState : () => {};
    if (!MANIFEST_CHANNELS.includes(this.channel)) throw new Error(`Unsupported model manifest channel: ${this.channel}`);
    const keyCount = this.publicKeys instanceof Map ? this.publicKeys.size : Object.keys(this.publicKeys || {}).length;
    const enabled = Boolean(this.sourcePool) && keyCount > 0;
    this.state = {
      enabled,
      status: enabled ? MODEL_MANIFEST_STATUS.IDLE : MODEL_MANIFEST_STATUS.DISABLED,
      channel: this.channel,
      sequence: null,
      sourceId: null,
      modelCount: 0,
      verifiedPath: null,
      checkedAt: null,
      error: null,
    };
    this.operation = null;
  }

  getState() {
    return clone(this.state);
  }

  _setState(patch) {
    this.state = { ...this.state, ...patch };
    try {
      this.onState(this.getState());
    } catch {
      // Renderer observers cannot affect the trust state.
    }
  }

  async _verifyCached(channel = this.channel) {
    const cached = await readJson(this.layout.verifiedModelManifest, { defaultValue: null });
    if (!cached) return null;
    const verified = verifySignedManifest(cached, {
      publicKeys: this.publicKeys,
      expectedKeyId: this.expectedKeyId,
      expectedChannel: channel,
      expectedPlatform: this.platform,
      expectedArch: this.arch,
      expectedAppVersion: this.appVersion || undefined,
      now: this.now(),
    });
    if (!Array.isArray(verified.payload.models) || verified.payload.models.length === 0) return null;
    return verified;
  }

  async initialize() {
    if (!this.state.enabled) return this.getState();
    await ensureRuntimeDirectories(this.layout);
    try {
      const cached = await this._verifyCached();
      if (cached) {
        this._setState({
          status: MODEL_MANIFEST_STATUS.READY,
          sequence: cached.sequence,
          modelCount: cached.payload.models.length,
          verifiedPath: this.layout.verifiedModelManifest,
          error: null,
        });
      }
    } catch (error) {
      await fs.rm(this.layout.verifiedModelManifest, { force: true }).catch(() => {});
      this._setState({ status: MODEL_MANIFEST_STATUS.FALLBACK, verifiedPath: null, error: error.message });
    }
    return this.getState();
  }

  async setChannel(channel) {
    const normalized = String(channel ?? "").trim().toLowerCase();
    if (!MANIFEST_CHANNELS.includes(normalized)) {
      return { success: false, code: "MODEL_MANIFEST_CHANNEL_UNSUPPORTED", state: this.getState() };
    }
    if (this.operation) return { success: false, code: "MODEL_MANIFEST_BUSY", state: this.getState() };
    this.channel = normalized;
    this._setState({
      channel: normalized,
      status: this.state.enabled ? MODEL_MANIFEST_STATUS.IDLE : MODEL_MANIFEST_STATUS.DISABLED,
      sequence: null,
      sourceId: null,
      modelCount: 0,
      verifiedPath: null,
      error: null,
    });
    return { success: true, channel: normalized, state: this.getState() };
  }

  async refresh({ channel = this.channel, signal } = {}) {
    if (!this.state.enabled) return { success: false, code: "MODEL_MANIFEST_DISABLED", state: this.getState() };
    if (this.operation) return { success: false, code: "MODEL_MANIFEST_BUSY", state: this.getState() };
    if (!MANIFEST_CHANNELS.includes(channel)) {
      return { success: false, code: "MODEL_MANIFEST_CHANNEL_UNSUPPORTED", state: this.getState() };
    }
    this.operation = "refresh";
    this._setState({ status: MODEL_MANIFEST_STATUS.CHECKING, channel, error: null });
    try {
      await ensureRuntimeDirectories(this.layout);
      const cached = await this._verifyCached(channel).catch(() => null);
      const minimumSequence = cached?.sequence;
      const manifestPath = assertSafeRelativePath(this.manifestPath(channel), "model manifest path");
      const { result, source } = await this.sourcePool.run(async (candidate) => {
        const request = createAbortSignal(signal, this.timeoutMs);
        try {
          const response = await this.fetchImpl(buildSourceUrl(candidate, manifestPath), {
            method: "GET",
            cache: "no-store",
            signal: request.signal,
          });
          const text = await responseText(response, candidate.id);
          const verified = verifySignedManifest(text, {
            publicKeys: this.publicKeys,
            expectedKeyId: this.expectedKeyId,
            expectedChannel: channel,
            expectedPlatform: this.platform,
            expectedArch: this.arch,
            expectedAppVersion: this.appVersion || undefined,
            minimumSequence,
            now: this.now(),
          });
          if (
            cached &&
            verified.sequence === cached.sequence &&
            verified.payloadSha256 !== cached.payloadSha256
          ) {
            throw new Error(`Model manifest sequence ${verified.sequence} already contains different bytes`);
          }
          return verified;
        } finally {
          request.cleanup();
        }
      }, {
        shouldFallback: (error) => [
          SOURCE_ERROR_KIND.NETWORK,
          SOURCE_ERROR_KIND.HTTP,
          SOURCE_ERROR_KIND.INTEGRITY,
        ].includes(error.kind),
      });
      if (!Array.isArray(result.payload.models) || result.payload.models.length === 0) {
        throw new Error("Signed model manifest contains no models");
      }
      await writeJsonAtomic(this.layout.verifiedModelManifest, result.manifest);
      this.channel = channel;
      this._setState({
        status: MODEL_MANIFEST_STATUS.READY,
        channel,
        sequence: result.sequence,
        sourceId: source.id,
        modelCount: result.payload.models.length,
        verifiedPath: this.layout.verifiedModelManifest,
        checkedAt: new Date(this.now()).toISOString(),
        error: null,
      });
      return { success: true, manifest: result, state: this.getState() };
    } catch (error) {
      const cached = await this._verifyCached(channel).catch(() => null);
      this._setState({
        status: MODEL_MANIFEST_STATUS.FALLBACK,
        sequence: cached?.sequence || null,
        modelCount: cached?.payload?.models?.length || 0,
        verifiedPath: cached ? this.layout.verifiedModelManifest : null,
        error: error.message,
      });
      return {
        success: Boolean(cached),
        code: cached ? "MODEL_MANIFEST_USING_CACHE" : "MODEL_MANIFEST_UNAVAILABLE",
        error: error.message,
        state: this.getState(),
      };
    } finally {
      this.operation = null;
    }
  }

  getBackendEnvironment() {
    if (!this.state.enabled) return {};
    return {
      MOONSHINE_REQUIRE_SIGNED_MODEL_MANIFEST: "1",
      MOONSHINE_MODEL_MANIFEST_CHANNEL: this.state.channel,
      ...(this.state.verifiedPath
        ? { MOONSHINE_MODEL_MANIFEST_PATH: this.state.verifiedPath }
        : {}),
    };
  }
}
