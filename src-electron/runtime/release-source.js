import { assertSafeRelativePath } from "./manifest-verifier.js";

const DEFAULT_FAILURE_COOLDOWN_MS = 60_000;
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429]);

export const SOURCE_ERROR_KIND = Object.freeze({
  NETWORK: "network",
  HTTP: "http",
  INTEGRITY: "integrity",
  DISK: "disk",
  CANCELLED: "cancelled",
  CONFIGURATION: "configuration",
});

export class ReleaseSourceError extends Error {
  constructor(message, { kind = SOURCE_ERROR_KIND.NETWORK, sourceId = null, status = null, cause } = {}) {
    super(message, { cause });
    this.name = "ReleaseSourceError";
    this.kind = kind;
    this.sourceId = sourceId;
    this.status = status;
    this.retryable = kind === SOURCE_ERROR_KIND.NETWORK || kind === SOURCE_ERROR_KIND.INTEGRITY ||
      kind === SOURCE_ERROR_KIND.HTTP;
  }
}

function normalizeBaseUrl(value, label) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    throw new ReleaseSourceError(`${label} is not a valid URL`, { kind: SOURCE_ERROR_KIND.CONFIGURATION });
  }
  if (url.protocol !== "https:") {
    throw new ReleaseSourceError(`${label} must use HTTPS`, { kind: SOURCE_ERROR_KIND.CONFIGURATION });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ReleaseSourceError(`${label} must not contain credentials or query parameters`, {
      kind: SOURCE_ERROR_KIND.CONFIGURATION,
    });
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function normalizeReleaseSource(source, index = 0) {
  if (!source || typeof source !== "object") {
    throw new ReleaseSourceError(`Source ${index + 1} must be an object`, {
      kind: SOURCE_ERROR_KIND.CONFIGURATION,
    });
  }
  const id = String(source.id ?? `source-${index + 1}`).trim();
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(id)) {
    throw new ReleaseSourceError(`Invalid release source id: ${id}`, { kind: SOURCE_ERROR_KIND.CONFIGURATION });
  }
  return Object.freeze({
    id,
    baseUrl: normalizeBaseUrl(source.baseUrl, `source ${id}`),
    priority: Number.isFinite(Number(source.priority)) ? Number(source.priority) : index,
    enabled: source.enabled !== false,
  });
}

export function normalizeReleaseSources(sources, { requireOne = true } = {}) {
  const values = Array.isArray(sources) ? sources : [];
  const normalized = values.filter((source) => source?.enabled !== false).map(normalizeReleaseSource);
  const ids = new Set();
  for (const source of normalized) {
    if (ids.has(source.id)) {
      throw new ReleaseSourceError(`Duplicate release source id: ${source.id}`, {
        kind: SOURCE_ERROR_KIND.CONFIGURATION,
      });
    }
    ids.add(source.id);
  }
  normalized.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  if (requireOne && normalized.length === 0) {
    throw new ReleaseSourceError("At least one release source is required", {
      kind: SOURCE_ERROR_KIND.CONFIGURATION,
    });
  }
  return normalized;
}

export function buildSourceUrl(source, artifactPath) {
  const normalizedSource = source.baseUrl ? normalizeReleaseSource(source) : source;
  const safePath = assertSafeRelativePath(artifactPath, "artifactPath");
  const encoded = safePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `${normalizedSource.baseUrl}/${encoded}`;
}

export function classifyHttpStatus(status, sourceId = null) {
  const numericStatus = Number(status);
  const error = new ReleaseSourceError(`Release source returned HTTP ${numericStatus}`, {
    kind: SOURCE_ERROR_KIND.HTTP,
    sourceId,
    status: numericStatus,
  });
  error.retryable = RETRYABLE_HTTP_STATUSES.has(numericStatus) || numericStatus >= 500;
  return error;
}

export function classifySourceError(error, sourceId = null) {
  if (error instanceof ReleaseSourceError) {
    if (!error.sourceId && sourceId) error.sourceId = sourceId;
    return error;
  }
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR") {
    return new ReleaseSourceError(error.message || "Release download was cancelled", {
      kind: SOURCE_ERROR_KIND.CANCELLED,
      sourceId,
      cause: error,
    });
  }
  return new ReleaseSourceError(error?.message || "Release source request failed", {
    kind: SOURCE_ERROR_KIND.NETWORK,
    sourceId,
    cause: error,
  });
}

export class ReleaseSourcePool {
  constructor({ sources, failureCooldownMs = DEFAULT_FAILURE_COOLDOWN_MS, now = () => Date.now() } = {}) {
    this.sources = normalizeReleaseSources(sources);
    this.failureCooldownMs = Math.max(0, Number(failureCooldownMs) || 0);
    this.now = now;
    this.health = new Map(this.sources.map((source) => [source.id, { failures: 0, unavailableUntil: 0 }]));
  }

  orderedSources() {
    const now = this.now();
    const available = this.sources.filter((source) => {
      const state = this.health.get(source.id);
      return !state || state.unavailableUntil <= now;
    });
    const cooling = this.sources.filter((source) => !available.includes(source));
    return [...available, ...cooling];
  }

  markSuccess(sourceId) {
    const state = this.health.get(sourceId);
    if (state) {
      state.failures = 0;
      state.unavailableUntil = 0;
    }
  }

  markFailure(sourceId) {
    const state = this.health.get(sourceId);
    if (!state) return;
    state.failures += 1;
    state.unavailableUntil = this.now() + this.failureCooldownMs * Math.min(state.failures, 5);
  }

  getHealth() {
    return Object.fromEntries([...this.health.entries()].map(([id, state]) => [id, { ...state }]));
  }

  async run(operation, { shouldFallback } = {}) {
    const fallbackPredicate = shouldFallback || ((error) => error?.retryable !== false);
    const errors = [];
    for (const source of this.orderedSources()) {
      try {
        const result = await operation(source);
        this.markSuccess(source.id);
        return { result, source };
      } catch (rawError) {
        const error = classifySourceError(rawError, source.id);
        errors.push(error);
        this.markFailure(source.id);
        if (error.kind === SOURCE_ERROR_KIND.CANCELLED || !fallbackPredicate(error, source)) {
          throw error;
        }
      }
    }
    const message = errors.length
      ? `All release sources failed: ${errors.map((error) => `${error.sourceId}: ${error.message}`).join("; ")}`
      : "No release source is available";
    throw new ReleaseSourceError(message, {
      kind: errors.at(-1)?.kind || SOURCE_ERROR_KIND.NETWORK,
      cause: errors.at(-1),
    });
  }
}

export { DEFAULT_FAILURE_COOLDOWN_MS };
