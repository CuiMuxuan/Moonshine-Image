import { DEFAULT_MASKING_CONFIG } from "src/shared/appConfigSchema";

const cacheContexts = new Map();
const preloadQueue = [];
const stats = {
  visibleCanvasCommitCount: 0,
  offscreenRenderCount: 0,
  cacheHitCount: 0,
  cacheMissCount: 0,
  evictionCount: 0,
  preloadQueueLength: 0,
  lastRenderedContextId: "",
  lastRenderReason: "",
};

const clampNumber = (value, fallback, min, max) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
};

export const normalizeSamRenderCacheConfig = (maskingConfig = {}) => ({
  enabled:
    typeof maskingConfig.samRenderCacheEnabled === "boolean"
      ? maskingConfig.samRenderCacheEnabled
      : DEFAULT_MASKING_CONFIG.samRenderCacheEnabled,
  maxContexts: clampNumber(
    maskingConfig.samRenderCacheMaxContexts,
    DEFAULT_MASKING_CONFIG.samRenderCacheMaxContexts,
    1,
    50
  ),
  maxMemoryBytes:
    clampNumber(
      maskingConfig.samRenderCacheMaxMemoryMb,
      DEFAULT_MASKING_CONFIG.samRenderCacheMaxMemoryMb,
      32,
      1024
    ) *
    1024 *
    1024,
  largeImageLongSide: clampNumber(
    maskingConfig.samRenderCacheLargeImageLongSide,
    DEFAULT_MASKING_CONFIG.samRenderCacheLargeImageLongSide,
    1024,
    12000
  ),
  lazyRenderDisabledCandidates:
    typeof maskingConfig.samLazyRenderDisabledCandidates === "boolean"
      ? maskingConfig.samLazyRenderDisabledCandidates
      : DEFAULT_MASKING_CONFIG.samLazyRenderDisabledCandidates,
  preloadVisibleList:
    typeof maskingConfig.samRenderCachePreloadVisibleList === "boolean"
      ? maskingConfig.samRenderCachePreloadVisibleList
      : DEFAULT_MASKING_CONFIG.samRenderCachePreloadVisibleList,
  neighborPreloadCount: clampNumber(
    maskingConfig.samRenderCacheNeighborPreloadCount,
    DEFAULT_MASKING_CONFIG.samRenderCacheNeighborPreloadCount,
    0,
    10
  ),
});

export const estimateSamRenderedMaskBytes = (value = "") =>
  typeof value === "string" ? value.length * 2 : 0;

export const estimateSamCandidateRenderBytes = (candidate = {}) =>
  estimateSamRenderedMaskBytes(candidate.renderedMask);

export const estimateSamSessionRenderBytes = (session = {}) =>
  (session.candidates || []).reduce(
    (total, candidate) => total + estimateSamCandidateRenderBytes(candidate),
    0
  );

export const clearSamCandidateRenderCache = (candidate = {}) => {
  if (!candidate || typeof candidate !== "object") return false;
  const hadCache = Boolean(candidate.renderedMask || candidate.renderedMaskMeta);
  delete candidate.renderedMask;
  delete candidate.renderedMaskMeta;
  return hadCache;
};

export const clearSamSessionRenderCache = (session = {}) => {
  let changed = false;
  for (const candidate of session.candidates || []) {
    changed = clearSamCandidateRenderCache(candidate) || changed;
  }
  return changed;
};

const readSession = (sessionStore, contextId) =>
  sessionStore?.get?.(String(contextId || "")) || null;

const totalEstimatedBytes = () =>
  [...cacheContexts.values()].reduce((total, entry) => total + Number(entry.estimatedBytes || 0), 0);

export const shouldKeepSamRenderedCache = ({
  width = 0,
  height = 0,
  maskingConfig = {},
} = {}) => {
  const config = normalizeSamRenderCacheConfig(maskingConfig);
  if (!config.enabled) return false;
  const longSide = Math.max(Number(width || 0), Number(height || 0));
  if (longSide > config.largeImageLongSide) return false;
  return true;
};

export const touchSamRenderCacheContext = ({
  contextId = "",
  sessionStore = null,
  maskingConfig = {},
  width = 0,
  height = 0,
} = {}) => {
  const normalizedContextId = String(contextId || "").trim();
  if (!normalizedContextId) return null;
  const config = normalizeSamRenderCacheConfig(maskingConfig);
  const session = readSession(sessionStore, normalizedContextId);
  const canKeep = shouldKeepSamRenderedCache({ width, height, maskingConfig });
  if (!config.enabled) {
    evictSamRenderCache({ sessionStore, maskingConfig: config });
    return null;
  }
  if (!canKeep) {
    clearSamRenderCacheContext(normalizedContextId, sessionStore);
    return null;
  }
  const estimatedBytes = estimateSamSessionRenderBytes(session || {});
  cacheContexts.set(normalizedContextId, {
    contextId: normalizedContextId,
    lastAccessedAt: Date.now(),
    estimatedBytes,
    width: Number(width || 0),
    height: Number(height || 0),
    canKeep,
  });
  evictSamRenderCache({ sessionStore, maskingConfig: config });
  return cacheContexts.get(normalizedContextId);
};

export const evictSamRenderCache = ({ sessionStore = null, maskingConfig = {} } = {}) => {
  const config = normalizeSamRenderCacheConfig(maskingConfig);
  if (!config.enabled) {
    for (const contextId of [...cacheContexts.keys()]) {
      clearSamRenderCacheContext(contextId, sessionStore);
    }
    return;
  }

  const ordered = [...cacheContexts.values()].sort(
    (left, right) => Number(left.lastAccessedAt || 0) - Number(right.lastAccessedAt || 0)
  );

  while (cacheContexts.size > config.maxContexts && ordered.length) {
    clearSamRenderCacheContext(ordered.shift().contextId, sessionStore);
  }

  while (totalEstimatedBytes() > config.maxMemoryBytes && ordered.length) {
    const next = ordered.shift();
    if (!cacheContexts.has(next.contextId)) continue;
    clearSamRenderCacheContext(next.contextId, sessionStore);
  }
};

export const clearSamRenderCacheContext = (contextId = "", sessionStore = null) => {
  const normalizedContextId = String(contextId || "").trim();
  if (!normalizedContextId) return false;
  const session = readSession(sessionStore, normalizedContextId);
  const changed = clearSamSessionRenderCache(session || {});
  const deleted = cacheContexts.delete(normalizedContextId);
  if (changed || deleted) {
    stats.evictionCount += 1;
  }
  return changed || deleted;
};

export const enqueueSamRenderPreload = (contextIds = [], priority = "visible") => {
  const uniqueIds = [...new Set(contextIds.map((id) => String(id || "").trim()).filter(Boolean))];
  for (const contextId of uniqueIds) {
    if (preloadQueue.some((item) => item.contextId === contextId)) continue;
    preloadQueue.push({
      contextId,
      priority,
      queuedAt: Date.now(),
    });
  }
  stats.preloadQueueLength = preloadQueue.length;
};

export const getSamRenderPreloadQueueLength = () => preloadQueue.length;

export const dequeueSamRenderPreload = () => {
  const item = preloadQueue.shift() || null;
  stats.preloadQueueLength = preloadQueue.length;
  return item;
};

export const clearSamRenderPreloadQueue = ({ priority = "" } = {}) => {
  if (!priority) {
    preloadQueue.splice(0);
    stats.preloadQueueLength = 0;
    return;
  }
  for (let index = preloadQueue.length - 1; index >= 0; index -= 1) {
    if (preloadQueue[index].priority === priority) {
      preloadQueue.splice(index, 1);
    }
  }
  stats.preloadQueueLength = preloadQueue.length;
};

export const recordSamRenderStat = (type, patch = {}) => {
  if (type && Object.prototype.hasOwnProperty.call(stats, type)) {
    stats[type] += 1;
  }
  Object.assign(stats, patch);
};

export const getSamRenderStats = () => ({ ...stats });

export const resetSamRenderStats = () => {
  Object.assign(stats, {
    visibleCanvasCommitCount: 0,
    offscreenRenderCount: 0,
    cacheHitCount: 0,
    cacheMissCount: 0,
    evictionCount: 0,
    preloadQueueLength: preloadQueue.length,
    lastRenderedContextId: "",
    lastRenderReason: "",
  });
};

export const getSamRenderCacheSnapshot = () => ({
  contexts: [...cacheContexts.values()].map((entry) => ({ ...entry })),
  totalEstimatedBytes: totalEstimatedBytes(),
  preloadQueue: preloadQueue.map((entry) => ({ ...entry })),
  stats: getSamRenderStats(),
});
