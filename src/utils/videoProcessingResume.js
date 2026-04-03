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

const buildMaskComparisonState = (masks = []) =>
  (Array.isArray(masks) ? masks : []).map((mask) => ({
    name: String(mask?.name || ""),
    enabled: mask?.enabled !== false,
    displayColor: String(mask?.displayColor || ""),
    startTime: normalizeNumber(mask?.startTime),
    endTime: normalizeNumber(mask?.endTime),
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
  }));

export const buildProcessingConfigSnapshot = ({
  fps = 0,
  exportFpsMode = "source",
  batchSize = 0,
  frameFormat = "jpg",
  masks = [],
  videoWidth = 0,
  videoHeight = 0,
  videoDuration = 0,
  defaultModel = "",
} = {}) => {
  const comparisonPayload = {
    fps: normalizeNumber(fps, 4),
    exportFpsMode: String(exportFpsMode || "source"),
    batchSize: Math.max(1, Math.round(Number(batchSize || 1))),
    frameFormat: String(frameFormat || "jpg").toLowerCase(),
    videoWidth: Math.max(0, Math.round(Number(videoWidth || 0))),
    videoHeight: Math.max(0, Math.round(Number(videoHeight || 0))),
    videoDuration: normalizeNumber(videoDuration, 4),
    defaultModel: String(defaultModel || ""),
    masks: buildMaskComparisonState(masks),
  };

  return {
    ...comparisonPayload,
    maskCount: comparisonPayload.masks.length,
    signature: hashString(JSON.stringify(comparisonPayload)),
  };
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

  return {
    taskId: String(safeTaskMeta.taskId || "").trim(),
    fingerprint: String(safeTaskMeta.fingerprint || "").trim(),
    taskRoot: String(safeTaskMeta.taskRoot || "").trim(),
    tempBase: String(safeTaskMeta.tempBase || "").trim(),
    sourcePath: String(safeTaskMeta.sourcePath || "").trim(),
    sourceName: String(safeTaskMeta.sourceName || "").trim(),
    temporarySourcePath: String(safeTaskMeta.temporarySourcePath || "").trim(),
    status: String(safeTaskMeta.status || "running"),
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
