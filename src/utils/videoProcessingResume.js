export const VIDEO_TASK_META_FILE_NAME = "task_meta.json";
export const VIDEO_TASK_DIRECTORY_PREFIX = "moonshine_video_task_";
export const VIDEO_PROCESSING_REGISTRY_VERSION = 1;

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const normalizeNumber = (value, digits = 6) => {
  const numericValue = Number(value || 0);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }
  return Number(numericValue.toFixed(digits));
};

const hashString = (input = "") => {
  let hash = FNV_OFFSET_BASIS;
  const text = String(input || "");

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }

  return hash.toString(16).padStart(8, "0");
};

const normalizeSamExpandPx = (value, fallbackValue) =>
  Math.max(0, Math.min(99, Math.round(Number(value ?? fallbackValue ?? 0) || 0)));

const buildSamComparisonState = (mask = {}) => {
  const objects = (Array.isArray(mask?.samObjects) ? mask.samObjects : [])
    .map((item) => ({
      objectId: Math.max(0, Math.round(Number(item?.objectId || 0))),
      enabled: item?.enabled !== false,
      expandPx: normalizeSamExpandPx(item?.expandPx, item?.autoExpandPx),
    }))
    .filter((item) => item.objectId > 0)
    .sort((left, right) => left.objectId - right.objectId);
  const frames = (Array.isArray(mask?.samFrames) ? mask.samFrames : [])
    .map((frame) => ({
      frameIndex: Math.max(0, Math.round(Number(frame?.frameIndex || 0))),
      time: normalizeNumber(frame?.time),
      masks: (Array.isArray(frame?.masks) ? frame.masks : [])
        .map((item) => ({
          objectId: Math.max(0, Math.round(Number(item?.objectId || 0))),
          signature: String(
            item?.maskSignature || item?.maskAssetId || item?.maskPath || ""
          ),
        }))
        .filter((item) => item.objectId > 0 && item.signature)
        .sort((left, right) =>
          left.objectId - right.objectId || left.signature.localeCompare(right.signature)
        ),
    }))
    .filter((frame) => frame.masks.length > 0)
    .sort((left, right) => left.frameIndex - right.frameIndex || left.time - right.time);

  return {
    objectCount: objects.length,
    frameCount: frames.length,
    signature: hashString(JSON.stringify({ objects, frames })),
  };
};

const buildMaskComparisonState = (masks = []) =>
  (Array.isArray(masks) ? masks : [])
    .map((mask) => {
      const samState = buildSamComparisonState(mask);
      return {
        id: String(mask?.id || ""),
        type: String(mask?.type || "standard"),
        enabled: mask?.enabled !== false,
        startTime: normalizeNumber(mask?.startTime),
        endTime: normalizeNumber(mask?.endTime),
        legacyProcessingRangeId: String(mask?.legacyProcessingRangeId || ""),
        baseMaskSignature: hashString(mask?.baseMaskDataUrl || ""),
        keyframes: (Array.isArray(mask?.keyframes) ? mask.keyframes : []).map((keyframe) => ({
          type: String(keyframe?.type || ""),
          time: normalizeNumber(keyframe?.time),
          x: normalizeNumber(keyframe?.x),
          y: normalizeNumber(keyframe?.y),
          scale: normalizeNumber(keyframe?.scale, 8),
          scaleX: normalizeNumber(keyframe?.scaleX, 8),
          scaleY: normalizeNumber(keyframe?.scaleY, 8),
          originScaleX: normalizeNumber(keyframe?.originScaleX, 8),
          originScaleY: normalizeNumber(keyframe?.originScaleY, 8),
        })),
        samObjectCount: samState.objectCount,
        samFrameCount: samState.frameCount,
        samStateSignature: samState.signature,
      };
    })
    .sort((left, right) =>
      left.id.localeCompare(right.id) || left.type.localeCompare(right.type)
    );

const buildRangeComparisonState = (ranges = []) =>
  (Array.isArray(ranges) ? ranges : []).map((range) => ({
    id: String(range?.id || ""),
    name: String(range?.name || ""),
    enabled: range?.enabled !== false,
    startTime: normalizeNumber(range?.startTime),
    endTime: normalizeNumber(range?.endTime),
  }));

export const buildProcessingConfigSnapshot = ({
  fps = 0,
  exportFpsMode = "source",
  batchSize = 0,
  frameFormat = "jpg",
  resultFrameFormat = "jpg",
  intermediateFrameStrategy = "performance",
  encodingQualityPreset = "performance",
  segmentCrf = 18,
  inpaintColorStabilization = "auto",
  modelId = "lama",
  modelOptions = {},
  masks = [],
  processingRanges = [],
  videoWidth = 0,
  videoHeight = 0,
  videoDuration = 0,
  defaultModel = "",
  temporalEnhancement = null,
} = {}) => {
  const comparisonPayload = {
    signatureVersion: 3,
    fps: normalizeNumber(fps, 4),
    exportFpsMode: String(exportFpsMode || "source"),
    batchSize: Math.max(1, Math.round(Number(batchSize || 1))),
    frameFormat: String(frameFormat || "jpg").toLowerCase(),
    resultFrameFormat: String(resultFrameFormat || "jpg").toLowerCase(),
    intermediateFrameStrategy: String(intermediateFrameStrategy || "performance"),
    encodingQualityPreset: String(encodingQualityPreset || "performance"),
    segmentCrf: Math.max(0, Math.round(Number(segmentCrf || 0))),
    inpaintColorStabilization: String(inpaintColorStabilization || "auto"),
    modelId: String(modelId || "lama"),
    modelOptions:
      modelOptions && typeof modelOptions === "object" && !Array.isArray(modelOptions)
        ? modelOptions
        : {},
    videoWidth: Math.max(0, Math.round(Number(videoWidth || 0))),
    videoHeight: Math.max(0, Math.round(Number(videoHeight || 0))),
    videoDuration: normalizeNumber(videoDuration, 4),
    defaultModel: String(defaultModel || ""),
    masks: buildMaskComparisonState(masks),
    processingRanges: buildRangeComparisonState(processingRanges),
  };
  const normalizedTemporalEnhancement =
    temporalEnhancement &&
    typeof temporalEnhancement === "object" &&
    !Array.isArray(temporalEnhancement) &&
    temporalEnhancement.enabled === true
      ? temporalEnhancement
      : null;

  if (normalizedTemporalEnhancement) {
    comparisonPayload.temporalEnhancement = normalizedTemporalEnhancement;
  }

  const snapshot = {
    ...comparisonPayload,
    maskCount: comparisonPayload.masks.length,
    processingRangeCount: comparisonPayload.processingRanges.length,
    signature: hashString(JSON.stringify(comparisonPayload)),
  };
  if (normalizedTemporalEnhancement) {
    snapshot.temporalEnhancement = normalizedTemporalEnhancement;
  }
  return snapshot;
};

export const hasProcessingConfigMismatch = (leftSnapshot, rightSnapshot) =>
  String(leftSnapshot?.signature || "") !== String(rightSnapshot?.signature || "");

export const createEmptyVideoProcessingRegistry = () => ({
  version: VIDEO_PROCESSING_REGISTRY_VERSION,
  updatedAt: new Date().toISOString(),
  tasks: {},
});

export const normalizeVideoProcessingRegistry = (registry) => {
  const safeRegistry =
    registry && typeof registry === "object" && !Array.isArray(registry) ? registry : {};

  return {
    version: VIDEO_PROCESSING_REGISTRY_VERSION,
    updatedAt: safeRegistry.updatedAt || new Date().toISOString(),
    tasks:
      safeRegistry.tasks &&
      typeof safeRegistry.tasks === "object" &&
      !Array.isArray(safeRegistry.tasks)
        ? safeRegistry.tasks
        : {},
  };
};

export const getVideoTaskTimestamp = (task = {}) =>
  Math.max(0, Number(task?.updatedAt || task?.createdAt || 0));

export const isResumableVideoTaskStatus = (status) =>
  ["failed", "running"].includes(String(status || ""));

export const findLatestResumableTaskSummary = (registry, fingerprint) => {
  const normalizedFingerprint = String(fingerprint || "").trim();
  if (!normalizedFingerprint) {
    return null;
  }

  const safeRegistry = normalizeVideoProcessingRegistry(registry);
  let latestTask = null;

  Object.values(safeRegistry.tasks).forEach((task) => {
    if (String(task?.fingerprint || "") !== normalizedFingerprint) {
      return;
    }
    if (task?.previewTrial === true) {
      return;
    }
    if (!isResumableVideoTaskStatus(task?.status)) {
      return;
    }

    if (!latestTask || getVideoTaskTimestamp(task) >= getVideoTaskTimestamp(latestTask)) {
      latestTask = task;
    }
  });

  return latestTask;
};

export const upsertVideoProcessingRegistryTask = (registry, taskSummary) => {
  const safeRegistry = normalizeVideoProcessingRegistry(registry);
  const taskId = String(taskSummary?.taskId || "").trim();

  if (!taskId) {
    return safeRegistry;
  }

  return {
    ...safeRegistry,
    updatedAt: new Date().toISOString(),
    tasks: {
      ...safeRegistry.tasks,
      [taskId]: {
        ...(safeRegistry.tasks[taskId] || {}),
        ...taskSummary,
      },
    },
  };
};

export const removeVideoProcessingRegistryTask = (registry, taskId) => {
  const safeRegistry = normalizeVideoProcessingRegistry(registry);
  const normalizedTaskId = String(taskId || "").trim();

  if (!normalizedTaskId || !safeRegistry.tasks[normalizedTaskId]) {
    return safeRegistry;
  }

  const nextTasks = { ...safeRegistry.tasks };
  delete nextTasks[normalizedTaskId];

  return {
    ...safeRegistry,
    updatedAt: new Date().toISOString(),
    tasks: nextTasks,
  };
};

export const normalizeVideoTaskMeta = (taskMeta = {}) => {
  const safeTaskMeta =
    taskMeta && typeof taskMeta === "object" && !Array.isArray(taskMeta) ? taskMeta : {};

  const completedSegments = (Array.isArray(safeTaskMeta.completedSegments)
    ? safeTaskMeta.completedSegments
    : []
  )
    .map((segment, index) => ({
      segmentIndex: Math.max(
        1,
        Math.round(Number(segment?.segmentIndex || segment?.batchNumber || index + 1))
      ),
      start: Math.max(0, Math.round(Number(segment?.start || 0))),
      end: Math.max(0, Math.round(Number(segment?.end || 0))),
      path: String(segment?.path || segment?.segmentPath || ""),
      fileName: String(segment?.fileName || ""),
      completedAt: Number(segment?.completedAt || Date.now()),
    }))
    .sort((left, right) => left.segmentIndex - right.segmentIndex);
  const rawTemporalCheckpoint =
    safeTaskMeta.temporalCheckpoint &&
    typeof safeTaskMeta.temporalCheckpoint === "object" &&
    !Array.isArray(safeTaskMeta.temporalCheckpoint)
      ? safeTaskMeta.temporalCheckpoint
      : null;
  const checkpointBatchNumber = Number(rawTemporalCheckpoint?.batchNumber);
  const checkpointLastFrameIndex = Number(rawTemporalCheckpoint?.lastFrameIndex);
  const temporalCheckpoint = rawTemporalCheckpoint
    ? {
        statePath: String(rawTemporalCheckpoint.statePath || "").trim(),
        cacheDir: String(rawTemporalCheckpoint.cacheDir || "").trim(),
        batchNumber: Number.isFinite(checkpointBatchNumber)
          ? Math.max(0, Math.round(checkpointBatchNumber))
          : 0,
        lastFrameIndex: Number.isFinite(checkpointLastFrameIndex)
          ? Math.max(-1, Math.round(checkpointLastFrameIndex))
          : -1,
      }
    : null;

  return {
    taskId: String(safeTaskMeta.taskId || "").trim(),
    fingerprint: String(safeTaskMeta.fingerprint || "").trim(),
    taskRoot: String(safeTaskMeta.taskRoot || "").trim(),
    tempBase: String(safeTaskMeta.tempBase || "").trim(),
    sourcePath: String(safeTaskMeta.sourcePath || "").trim(),
    sourceName: String(safeTaskMeta.sourceName || "").trim(),
    temporarySourcePath: String(safeTaskMeta.temporarySourcePath || "").trim(),
    status: String(safeTaskMeta.status || "running"),
    previewTrial: safeTaskMeta.previewTrial === true,
    previewTrialSeconds: Math.max(0, Number(safeTaskMeta.previewTrialSeconds || 0)),
    createdAt: Number(safeTaskMeta.createdAt || Date.now()),
    updatedAt: Number(safeTaskMeta.updatedAt || Date.now()),
    totalFrames: Math.max(1, Math.round(Number(safeTaskMeta.totalFrames || 1))),
    totalBatches: Math.max(
      1,
      Math.round(
        Number(
          safeTaskMeta.totalBatches ||
            completedSegments.length ||
            1
        )
      )
    ),
    videoWidth: Math.max(0, Math.round(Number(safeTaskMeta.videoWidth || 0))),
    videoHeight: Math.max(0, Math.round(Number(safeTaskMeta.videoHeight || 0))),
    videoDuration: Math.max(0, Number(safeTaskMeta.videoDuration || 0)),
    completedSegments,
    temporalCheckpoint:
      temporalCheckpoint?.statePath && temporalCheckpoint?.cacheDir ? temporalCheckpoint : null,
    configSnapshot:
      safeTaskMeta.configSnapshot &&
      typeof safeTaskMeta.configSnapshot === "object" &&
      !Array.isArray(safeTaskMeta.configSnapshot)
        ? safeTaskMeta.configSnapshot
        : null,
    lastError: String(safeTaskMeta.lastError || ""),
    lastOutputPath: String(safeTaskMeta.lastOutputPath || ""),
    frameDecodeFallbackReportPath: String(safeTaskMeta.frameDecodeFallbackReportPath || ""),
  };
};
