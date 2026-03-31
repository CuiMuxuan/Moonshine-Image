import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { v4 as uuidv4 } from "uuid";

import {
  DEFAULT_VIDEO_BRUSH,
  normalizeBrushConfig,
} from "src/config/ConfigManager";
import { useRuntimeUiStore } from "src/stores/runtimeUi";
import { MASK_TOOL_MODES, normalizeMaskToolMode } from "src/utils/maskTool";
import {
  getInterpolatedMaskTransform,
  getMaskKeyframeTransform,
  MASK_KEYFRAME_TYPES,
  sortMaskKeyframes,
} from "src/utils/videoMaskUtils";

const KEYFRAME_TOLERANCE = 0.0005;
const DEFAULT_TRANSFORM = Object.freeze({
  x: 0,
  y: 0,
  scale: 1,
});

const DEFAULT_MASK_TOOL = Object.freeze({
  drawingEnabled: true,
  mode: MASK_TOOL_MODES.DRAW,
  brushSize: DEFAULT_VIDEO_BRUSH.size,
  brushAlpha: DEFAULT_VIDEO_BRUSH.alpha,
  brushColor: DEFAULT_VIDEO_BRUSH.color,
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const isSameTime = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) <= KEYFRAME_TOLERANCE;

const cloneKeyframe = (keyframe) => ({
  ...keyframe,
});

const cloneMask = (mask) => ({
  ...mask,
  keyframes: (mask?.keyframes || []).map(cloneKeyframe),
});

const cloneMaskTool = (tool = {}) => ({
  drawingEnabled: Boolean(tool.drawingEnabled),
  mode: normalizeMaskToolMode(tool.mode),
  brushSize: Math.max(2, Number(tool.brushSize ?? DEFAULT_MASK_TOOL.brushSize)),
  brushAlpha: clamp(Number(tool.brushAlpha ?? DEFAULT_MASK_TOOL.brushAlpha), 0.05, 1),
  brushColor: tool.brushColor ?? DEFAULT_MASK_TOOL.brushColor,
});

const createTransparentMaskDataUrl = (width, height) => {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(width || 1));
  canvas.height = Math.max(1, Math.floor(height || 1));
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
};

const normalizeKeyframe = (
  keyframe = {},
  fallbackTime = 0,
  fallbackType = MASK_KEYFRAME_TYPES.USER
) => {
  const transform = getMaskKeyframeTransform(keyframe, DEFAULT_TRANSFORM);
  return {
    id: keyframe.id || uuidv4(),
    type: keyframe.type || fallbackType,
    time: Number(keyframe.time ?? fallbackTime),
    x: transform.x,
    y: transform.y,
    scale: transform.scale,
  };
};

const getLegacyKeyframeGroups = (keyframes = []) => {
  const safeKeyframes = Array.isArray(keyframes) ? keyframes.map(cloneKeyframe) : [];
  const hasTypedKeyframe = safeKeyframes.some((item) =>
    Object.values(MASK_KEYFRAME_TYPES).includes(item?.type)
  );

  if (hasTypedKeyframe) {
    const start = safeKeyframes.find((item) => item.type === MASK_KEYFRAME_TYPES.START) || null;
    const end = safeKeyframes.find((item) => item.type === MASK_KEYFRAME_TYPES.END) || null;
    const users = safeKeyframes.filter((item) => item.type === MASK_KEYFRAME_TYPES.USER);
    return { start, end, users };
  }

  const ordered = [...safeKeyframes].sort((a, b) => Number(a.time || 0) - Number(b.time || 0));
  return {
    start: ordered[0] || null,
    end: ordered.length > 1 ? ordered[ordered.length - 1] : ordered[0] || null,
    users: ordered.slice(1, -1),
  };
};

const dedupeUserKeyframes = (keyframes, startTime, endTime) => {
  const nextKeyframes = [];

  sortMaskKeyframes(keyframes).forEach((keyframe) => {
    const normalized = normalizeKeyframe(
      {
        ...keyframe,
        type: MASK_KEYFRAME_TYPES.USER,
      },
      clamp(Number(keyframe.time ?? startTime), startTime, endTime),
      MASK_KEYFRAME_TYPES.USER
    );

    if (
      normalized.time <= startTime + KEYFRAME_TOLERANCE ||
      normalized.time >= endTime - KEYFRAME_TOLERANCE
    ) {
      return;
    }

    const hasConflict = nextKeyframes.some((item) => isSameTime(item.time, normalized.time));
    if (!hasConflict) {
      nextKeyframes.push(normalized);
    }
  });

  return nextKeyframes;
};

const getKeyframeByType = (mask, type) =>
  sortMaskKeyframes(mask?.keyframes || []).find((item) => item.type === type) || null;

const getUserKeyframes = (mask) =>
  sortMaskKeyframes(mask?.keyframes || []).filter((item) => item.type === MASK_KEYFRAME_TYPES.USER);

const syncInheritedEndKeyframe = (mask) => {
  if (!mask || mask.endStateExplicit) return mask;

  const nextMask = cloneMask(mask);
  const endKeyframe = getKeyframeByType(nextMask, MASK_KEYFRAME_TYPES.END);
  if (!endKeyframe) return nextMask;

  const previousKeyframe =
    sortMaskKeyframes(nextMask.keyframes)
      .filter(
        (item) =>
          item.id !== endKeyframe.id &&
          Number(item.time || 0) <= Number(endKeyframe.time || 0) + KEYFRAME_TOLERANCE
      )
      .at(-1) || getKeyframeByType(nextMask, MASK_KEYFRAME_TYPES.START);

  if (!previousKeyframe) return nextMask;

  nextMask.keyframes = nextMask.keyframes.map((item) =>
    item.id === endKeyframe.id
      ? {
          ...item,
          x: previousKeyframe.x,
          y: previousKeyframe.y,
          scale: previousKeyframe.scale,
        }
      : item
  );
  return nextMask;
};

const reconcileMask = (mask = {}, duration = 0) => {
  const safeDuration = Math.max(0, Number(duration || 0));
  const startTime = clamp(Number(mask.startTime ?? 0), 0, safeDuration);
  const endTime = clamp(Number(mask.endTime ?? safeDuration), startTime, safeDuration);

  const { start: startCandidate, end: endCandidate, users: userCandidates } =
    getLegacyKeyframeGroups(mask.keyframes);

  const startTransform = getMaskKeyframeTransform(startCandidate, DEFAULT_TRANSFORM);
  const startKeyframe = normalizeKeyframe(
    {
      ...startCandidate,
      ...startTransform,
      type: MASK_KEYFRAME_TYPES.START,
      time: startTime,
    },
    startTime,
    MASK_KEYFRAME_TYPES.START
  );

  const endTransform = getMaskKeyframeTransform(endCandidate, startTransform);
  const endKeyframe = normalizeKeyframe(
    {
      ...endCandidate,
      ...endTransform,
      type: MASK_KEYFRAME_TYPES.END,
      time: endTime,
    },
    endTime,
    MASK_KEYFRAME_TYPES.END
  );

  const userKeyframes = dedupeUserKeyframes(userCandidates, startTime, endTime);

  const normalizedMask = {
    id: mask.id || uuidv4(),
    name: mask.name || "蒙版",
    enabled: mask.enabled !== false,
    baseMaskDataUrl: mask.baseMaskDataUrl || "",
    interpolation: mask.interpolation || "linear",
    startTime,
    endTime,
    endStateExplicit: Boolean(mask.endStateExplicit),
    keyframes: sortMaskKeyframes([startKeyframe, ...userKeyframes, endKeyframe]),
  };

  return syncInheritedEndKeyframe(normalizedMask);
};

const createResult = (ok, payload = {}) => ({
  ok,
  ...payload,
});

export const useVideoManagerStore = defineStore("videoManager", () => {
  const runtimeUiStore = useRuntimeUiStore();
  const videoFile = ref(null);
  const hasVideoFile = ref(false);
  const playerWidth = ref(0);
  const playerHeight = ref(0);
  const isPlaying = ref(false);
  const isMuted = ref(false);
  const currentTime = ref(0);
  const playbackRate = ref(1);
  const videoWidth = ref(0);
  const videoHeight = ref(0);
  const videoDuration = ref(0);
  const sourceFrameRate = ref(30);
  const displayWidth = ref(0);
  const displayHeight = ref(0);
  const masks = ref([]);
  const selectedMaskId = ref(null);
  const selectedKeyframeId = ref(null);
  const maskTool = ref(
    cloneMaskTool({
      ...DEFAULT_MASK_TOOL,
      drawingEnabled: runtimeUiStore.videoMaskDrawingEnabled,
    })
  );
  const maskToolDefaults = ref({ ...DEFAULT_VIDEO_BRUSH });
  const currentSourcePath = ref("");
  const currentSourceName = ref("");
  const currentSourceIsReplacement = ref(false);
  const videoHistory = ref([]);
  const maskDrawHistory = ref({});

  const selectedMask = computed(
    () => masks.value.find((item) => item.id === selectedMaskId.value) || null
  );
  const selectedKeyframe = computed(() => {
    const mask = selectedMask.value;
    if (!mask || !selectedKeyframeId.value) return null;
    return mask.keyframes.find((item) => item.id === selectedKeyframeId.value) || null;
  });
  const selectedMaskOrderedKeyframes = computed(() =>
    sortMaskKeyframes(selectedMask.value?.keyframes || [])
  );
  const selectedMaskUserKeyframes = computed(() =>
    selectedMaskOrderedKeyframes.value.filter((item) => item.type === MASK_KEYFRAME_TYPES.USER)
  );
  const hasSelectedMask = computed(() => Boolean(selectedMask.value));
  const canDeleteSelectedKeyframe = computed(
    () => selectedKeyframe.value?.type === MASK_KEYFRAME_TYPES.USER
  );
  const canEditSelectedKeyframeTime = computed(
    () => selectedKeyframe.value?.type === MASK_KEYFRAME_TYPES.USER
  );
  const canEditSelectedKeyframeTransform = computed(
    () =>
      selectedKeyframe.value?.type === MASK_KEYFRAME_TYPES.USER ||
      selectedKeyframe.value?.type === MASK_KEYFRAME_TYPES.END
  );
  const hasVideoHistory = computed(() => videoHistory.value.length > 0);
  const canOpenVideoHistory = computed(
    () => currentSourceIsReplacement.value && videoHistory.value.length > 0
  );

  const getMaskById = (maskId) => masks.value.find((item) => item.id === maskId) || null;
  const getMaskIndexById = (maskId) => masks.value.findIndex((item) => item.id === maskId);
  const createMaskDrawHistoryState = (baseMaskDataUrl = "") => ({
    snapshots: [baseMaskDataUrl || ""],
    index: 0,
  });
  const setMaskDrawHistoryState = (maskId, state) => {
    maskDrawHistory.value = {
      ...maskDrawHistory.value,
      [maskId]: state,
    };
    return state;
  };
  const removeMaskDrawHistoryState = (maskId) => {
    if (!maskId || !maskDrawHistory.value[maskId]) return;

    const nextHistory = { ...maskDrawHistory.value };
    delete nextHistory[maskId];
    maskDrawHistory.value = nextHistory;
  };
  const clearMaskDrawHistory = () => {
    maskDrawHistory.value = {};
  };
  const ensureMaskDrawHistory = (maskId, baseMaskDataUrl = "") => {
    const normalized = baseMaskDataUrl || "";
    const state = maskDrawHistory.value[maskId];

    if (state?.snapshots?.length) {
      const currentSnapshot = state.snapshots[state.index] ?? "";
      if (currentSnapshot === normalized) {
        return state;
      }
    }

    return setMaskDrawHistoryState(maskId, createMaskDrawHistoryState(normalized));
  };
  const canUndoMaskDraw = (maskId) => {
    const mask = getMaskById(maskId);
    if (!mask) return false;

    const state = ensureMaskDrawHistory(maskId, mask.baseMaskDataUrl || "");
    return state.index > 0;
  };
  const canUndoSelectedMaskDraw = computed(() =>
    selectedMask.value ? canUndoMaskDraw(selectedMask.value.id) : false
  );

  const syncSelectionForMask = (mask) => {
    if (!mask || selectedMaskId.value !== mask.id) return;
    if (
      selectedKeyframeId.value &&
      !mask.keyframes.some((item) => item.id === selectedKeyframeId.value)
    ) {
      selectedKeyframeId.value = null;
    }
  };

  const commitMask = (maskId, nextMaskInput) => {
    const index = getMaskIndexById(maskId);
    if (index === -1) return null;

    const nextMask = reconcileMask(nextMaskInput, videoDuration.value);
    const nextMasks = [...masks.value];
    nextMasks[index] = nextMask;
    masks.value = nextMasks;
    syncSelectionForMask(nextMask);
    return nextMask;
  };

  const getVideoFileInfo = () => {
    if (!videoFile.value) return null;
    return {
      name: videoFile.value.name,
      size: videoFile.value.size,
      type: videoFile.value.type,
      lastModified: videoFile.value.lastModified,
      path: currentSourcePath.value || videoFile.value.path || "",
      isReplacement: currentSourceIsReplacement.value,
    };
  };

  const resetEditorState = () => {
    masks.value = [];
    selectedMaskId.value = null;
    selectedKeyframeId.value = null;
    currentTime.value = 0;
    isPlaying.value = false;
    playbackRate.value = 1;
    isMuted.value = false;
    maskTool.value = cloneMaskTool({
      ...DEFAULT_MASK_TOOL,
      drawingEnabled: runtimeUiStore.videoMaskDrawingEnabled,
      brushSize: maskToolDefaults.value.size,
      brushAlpha: maskToolDefaults.value.alpha,
      brushColor: maskToolDefaults.value.color,
    });
    clearMaskDrawHistory();
  };

  const clearVideoInfo = () => {
    videoWidth.value = 0;
    videoHeight.value = 0;
    videoDuration.value = 0;
    sourceFrameRate.value = 30;
    displayWidth.value = 0;
    displayHeight.value = 0;
  };

  const clearVideoHistory = () => {
    videoHistory.value = [];
    currentSourcePath.value = "";
    currentSourceName.value = "";
    currentSourceIsReplacement.value = false;
  };

  const ensureMasksStayInRange = () => {
    masks.value = masks.value.map((mask, index) =>
      reconcileMask(
        {
          ...mask,
          name: mask.name || `蒙版 ${index + 1}`,
        },
        videoDuration.value
      )
    );

    if (selectedMaskId.value && !getMaskById(selectedMaskId.value)) {
      selectedMaskId.value = null;
      selectedKeyframeId.value = null;
      return;
    }

    if (selectedMask.value) {
      syncSelectionForMask(selectedMask.value);
    }
  };

  const captureEditorSnapshot = (uiState = {}) => ({
    currentTime: Number(currentTime.value || 0),
    playbackRate: Number(playbackRate.value || 1),
    isMuted: Boolean(isMuted.value),
    videoWidth: Number(videoWidth.value || 0),
    videoHeight: Number(videoHeight.value || 0),
    videoDuration: Number(videoDuration.value || 0),
    sourceFrameRate: Number(sourceFrameRate.value || 30),
    displayWidth: Number(displayWidth.value || 0),
    displayHeight: Number(displayHeight.value || 0),
    selectedMaskId: selectedMaskId.value,
    selectedKeyframeId: selectedKeyframeId.value,
    masks: masks.value.map(cloneMask),
    maskTool: cloneMaskTool(maskTool.value),
    uiState: JSON.parse(JSON.stringify(uiState || {})),
  });

  const restoreEditorSnapshot = (snapshot = {}, options = {}) => {
    const { preserveVideoInfo = false } = options;
    const duration = Math.max(
      0,
      Number(
        preserveVideoInfo
          ? videoDuration.value || snapshot.videoDuration || 0
          : snapshot.videoDuration || videoDuration.value || 0
      )
    );

    if (!preserveVideoInfo) {
      videoWidth.value = Math.max(0, Number(snapshot.videoWidth || 0));
      videoHeight.value = Math.max(0, Number(snapshot.videoHeight || 0));
      videoDuration.value = duration;
      sourceFrameRate.value = Math.max(1, Number(snapshot.sourceFrameRate || 30));
      displayWidth.value = Math.max(0, Number(snapshot.displayWidth || 0));
      displayHeight.value = Math.max(0, Number(snapshot.displayHeight || 0));
    }

    masks.value = (snapshot.masks || []).map((mask, index) =>
      reconcileMask(
        {
          ...cloneMask(mask),
          name: mask.name || `蒙版 ${index + 1}`,
        },
        duration
      )
    );
    clearMaskDrawHistory();
    masks.value.forEach((mask) => {
      ensureMaskDrawHistory(mask.id, mask.baseMaskDataUrl || "");
    });

    selectedMaskId.value =
      snapshot.selectedMaskId && masks.value.some((item) => item.id === snapshot.selectedMaskId)
        ? snapshot.selectedMaskId
        : null;

    const mask = selectedMaskId.value ? getMaskById(selectedMaskId.value) : null;
    selectedKeyframeId.value =
      snapshot.selectedKeyframeId &&
      mask?.keyframes.some((item) => item.id === snapshot.selectedKeyframeId)
        ? snapshot.selectedKeyframeId
        : null;

    currentTime.value = clamp(Number(snapshot.currentTime || 0), 0, duration);
    playbackRate.value = Math.max(0.1, Number(snapshot.playbackRate || 1));
    isMuted.value = Boolean(snapshot.isMuted);
    isPlaying.value = false;
    maskTool.value = cloneMaskTool({
      ...(snapshot.maskTool || DEFAULT_MASK_TOOL),
      drawingEnabled: runtimeUiStore.videoMaskDrawingEnabled,
    });

    return {
      uiState: JSON.parse(JSON.stringify(snapshot.uiState || {})),
    };
  };

  const buildHistoryEntry = ({ uiState = {}, label } = {}) => {
    if (!videoFile.value) return null;

    return {
      id: uuidv4(),
      createdAt: Date.now(),
      label: label || currentSourceName.value || videoFile.value.name || "视频记录",
      fileName: currentSourceName.value || videoFile.value.name || "video.mp4",
      filePath: currentSourcePath.value || videoFile.value.path || "",
      isReplacement: Boolean(currentSourceIsReplacement.value),
      videoFile: videoFile.value,
      snapshot: captureEditorSnapshot(uiState),
    };
  };

  const pushHistoryEntry = (entry, historyLimit = 5) => {
    if (!entry) return;
    const limit = Math.max(1, Number(historyLimit || 5));
    const nextEntries = [...videoHistory.value, entry];
    while (nextEntries.length > limit) {
      nextEntries.shift();
    }
    videoHistory.value = nextEntries;
  };

  const removeHistoryFrom = (entryId) => {
    const index = videoHistory.value.findIndex((item) => item.id === entryId);
    if (index === -1) return null;
    const [selectedEntry] = videoHistory.value.slice(index, index + 1);
    videoHistory.value = videoHistory.value.slice(0, index);
    return selectedEntry || null;
  };

  const setVideoFile = (file, options = {}) => {
    const {
      resetEditor = false,
      resetHistory = false,
      sourcePath = file?.path || "",
      sourceName = file?.name || "",
      isReplacementSource = false,
    } = options;

    videoFile.value = file;
    hasVideoFile.value = Boolean(file);

    if (!file) {
      resetEditorState();
      clearVideoInfo();
      clearVideoHistory();
      return;
    }

    if (resetEditor) {
      resetEditorState();
      clearVideoInfo();
    }

    if (resetHistory) {
      videoHistory.value = [];
    }

    currentSourcePath.value = sourcePath || "";
    currentSourceName.value = sourceName || file.name || "";
    currentSourceIsReplacement.value = Boolean(isReplacementSource);
  };

  const clearVideoFile = () => {
    videoFile.value = null;
    hasVideoFile.value = false;
    resetEditorState();
    clearVideoInfo();
    clearVideoHistory();
  };

  const setCurrentSourceMeta = ({ sourcePath, sourceName, isReplacementSource } = {}) => {
    if (typeof sourcePath === "string") currentSourcePath.value = sourcePath;
    if (typeof sourceName === "string") currentSourceName.value = sourceName;
    if (typeof isReplacementSource === "boolean") {
      currentSourceIsReplacement.value = isReplacementSource;
    }
  };

  const setPlayerSize = (width, height) => {
    playerWidth.value = width;
    playerHeight.value = height;
  };

  const adjustPlayerSize = (containerWidth, containerHeight) => {
    setPlayerSize(Math.floor(containerWidth), Math.floor(containerHeight));
  };

  const setIsPlaying = (playing) => {
    isPlaying.value = playing;
  };

  const setIsMuted = (muted) => {
    isMuted.value = Boolean(muted);
  };

  const setCurrentTime = (time) => {
    currentTime.value = clamp(Number(time || 0), 0, Math.max(0, videoDuration.value || 0));
  };

  const setPlaybackRate = (rate) => {
    playbackRate.value = Number(rate || 1);
  };

  const setSourceFrameRate = (fps) => {
    const normalized = Number(fps);
    sourceFrameRate.value = Number.isFinite(normalized) && normalized > 0 ? normalized : 30;
  };

  const calculateDisplaySize = (containerWidth, containerHeight) => {
    if (videoWidth.value === 0 || videoHeight.value === 0) {
      displayWidth.value = containerWidth;
      displayHeight.value = containerHeight;
      return;
    }

    const videoAspectRatio = videoWidth.value / videoHeight.value;
    const containerAspectRatio = containerWidth / containerHeight;

    let newWidth;
    let newHeight;

    if (videoAspectRatio > containerAspectRatio) {
      newWidth = containerWidth;
      newHeight = containerWidth / videoAspectRatio;
    } else {
      newHeight = containerHeight;
      newWidth = containerHeight * videoAspectRatio;
    }

    displayWidth.value = Math.floor(newWidth);
    displayHeight.value = Math.floor(newHeight);
  };

  const setVideoInfo = (width, height, duration) => {
    videoWidth.value = width;
    videoHeight.value = height;
    videoDuration.value = Math.max(0, Number(duration || 0));
    ensureMasksStayInRange();
  };

  const selectMask = (maskId, keyframeId = undefined) => {
    const mask = getMaskById(maskId);
    if (!mask) {
      selectedMaskId.value = null;
      selectedKeyframeId.value = null;
      return;
    }

    selectedMaskId.value = mask.id;

    if (keyframeId === undefined) {
      if (!mask.keyframes.some((item) => item.id === selectedKeyframeId.value)) {
        selectedKeyframeId.value = null;
      }
      return;
    }

    if (keyframeId === null) {
      selectedKeyframeId.value = null;
      return;
    }

    selectedKeyframeId.value = mask.keyframes.some((item) => item.id === keyframeId)
      ? keyframeId
      : null;
  };

  const selectKeyframe = (maskId, keyframeId) => {
    selectMask(maskId, keyframeId);
  };

  const createMask = ({
    name,
    startTime = 0,
    endTime = videoDuration.value,
    transform = DEFAULT_TRANSFORM,
  } = {}) => {
    const duration = Math.max(0, videoDuration.value || 0);
    const clampedStart = clamp(Number(startTime || 0), 0, duration);
    const clampedEnd = clamp(Number(endTime ?? duration), clampedStart, duration);
    const order = masks.value.length + 1;
    const baseMaskDataUrl = createTransparentMaskDataUrl(
      videoWidth.value || 1,
      videoHeight.value || 1
    );
    const initialTransform = getMaskKeyframeTransform(transform, DEFAULT_TRANSFORM);

    const mask = reconcileMask(
      {
        id: uuidv4(),
        name: name || `蒙版 ${order}`,
        enabled: true,
        baseMaskDataUrl,
        interpolation: "linear",
        startTime: clampedStart,
        endTime: clampedEnd,
        endStateExplicit: false,
        keyframes: [
          {
            id: uuidv4(),
            type: MASK_KEYFRAME_TYPES.START,
            time: clampedStart,
            ...initialTransform,
          },
          {
            id: uuidv4(),
            type: MASK_KEYFRAME_TYPES.END,
            time: clampedEnd,
            ...initialTransform,
          },
        ],
      },
      duration
    );

    masks.value = [...masks.value, mask];
    ensureMaskDrawHistory(mask.id, mask.baseMaskDataUrl || "");
    selectMask(mask.id, null);
    updateMaskTool({
      drawingEnabled: true,
      mode: MASK_TOOL_MODES.DRAW,
    });
    return mask;
  };

  const removeMask = (maskId) => {
    const nextMasks = masks.value.filter((item) => item.id !== maskId);
    masks.value = nextMasks;
    removeMaskDrawHistoryState(maskId);

    if (selectedMaskId.value === maskId) {
      const fallbackMask = nextMasks[0] || null;
      selectedMaskId.value = fallbackMask?.id || null;
      selectedKeyframeId.value = null;
    }

    return true;
  };

  const updateMask = (maskId, patch) => {
    const currentMask = getMaskById(maskId);
    if (!currentMask) return null;

    return commitMask(maskId, {
      ...cloneMask(currentMask),
      ...patch,
      keyframes: patch?.keyframes ?? currentMask.keyframes,
    });
  };

  const updateSelectedMask = (patch) => {
    if (!selectedMaskId.value) return null;
    return updateMask(selectedMaskId.value, patch);
  };

  const setMaskBaseMask = (maskId, baseMaskDataUrl) => updateMask(maskId, { baseMaskDataUrl });
  const commitMaskBaseMask = (maskId, baseMaskDataUrl) => {
    const mask = getMaskById(maskId);
    if (!mask) return null;

    const normalized = baseMaskDataUrl || "";
    const state = ensureMaskDrawHistory(maskId, mask.baseMaskDataUrl || "");
    const currentSnapshot = state.snapshots[state.index] ?? (mask.baseMaskDataUrl || "");

    if (currentSnapshot === normalized) {
      return mask;
    }

    const nextSnapshots = state.snapshots.slice(0, state.index + 1);
    nextSnapshots.push(normalized);
    setMaskDrawHistoryState(maskId, {
      snapshots: nextSnapshots,
      index: nextSnapshots.length - 1,
    });

    return setMaskBaseMask(maskId, normalized);
  };

  const setSelectedMaskBaseMask = (baseMaskDataUrl) => {
    if (!selectedMaskId.value) return null;
    return setMaskBaseMask(selectedMaskId.value, baseMaskDataUrl);
  };
  const commitSelectedMaskBaseMask = (baseMaskDataUrl) => {
    if (!selectedMaskId.value) return null;
    return commitMaskBaseMask(selectedMaskId.value, baseMaskDataUrl);
  };
  const undoMaskDraw = (maskId) => {
    const mask = getMaskById(maskId);
    if (!mask) return null;

    const state = ensureMaskDrawHistory(maskId, mask.baseMaskDataUrl || "");
    if (state.index <= 0) return null;

    const nextIndex = state.index - 1;
    const previousSnapshot = state.snapshots[nextIndex] ?? "";
    setMaskDrawHistoryState(maskId, {
      snapshots: [...state.snapshots],
      index: nextIndex,
    });

    return setMaskBaseMask(maskId, previousSnapshot);
  };
  const undoSelectedMaskDraw = () => {
    if (!selectedMaskId.value) return null;
    return undoMaskDraw(selectedMaskId.value);
  };

  const getMaskStateAtTime = (maskId, time) => {
    const mask = getMaskById(maskId);
    if (!mask || !mask.enabled) return null;

    const transform = getInterpolatedMaskTransform(mask, Number(time ?? currentTime.value ?? 0));
    if (!transform) return null;

    return {
      mask,
      ...transform,
    };
  };

  const validateUserKeyframeTime = (mask, targetTime, currentKeyframeId = null) => {
    if (targetTime <= mask.startTime + KEYFRAME_TOLERANCE) {
      return "用户关键帧不能与开始关键帧重合。";
    }

    if (targetTime >= mask.endTime - KEYFRAME_TOLERANCE) {
      return "用户关键帧不能与结束关键帧重合。";
    }

    const hasConflict = mask.keyframes.some(
      (item) => item.id !== currentKeyframeId && isSameTime(item.time, targetTime)
    );
    if (hasConflict) {
      return "该时间点已经存在关键帧。";
    }

    return "";
  };

  const createUserKeyframe = (maskId, keyframeInput = {}, options = {}) => {
    const mask = getMaskById(maskId);
    if (!mask) {
      return createResult(false, {
        code: "mask-not-found",
        error: "未找到对应的蒙版。",
      });
    }

    const requestedTime = clamp(
      Number(keyframeInput.time ?? currentTime.value),
      mask.startTime,
      mask.endTime
    );

    const exactKeyframe =
      sortMaskKeyframes(mask.keyframes).find((item) => isSameTime(item.time, requestedTime)) || null;

    if (exactKeyframe) {
      if (options.reuseExisting !== false && exactKeyframe.type !== MASK_KEYFRAME_TYPES.START) {
        if (options.select !== false) {
          selectMask(maskId, exactKeyframe.id);
        }

        return createResult(true, {
          mask,
          keyframe: exactKeyframe,
          reused: true,
        });
      }

      return createResult(false, {
        code: exactKeyframe.type === MASK_KEYFRAME_TYPES.START ? "start-locked" : "time-conflict",
        error:
          exactKeyframe.type === MASK_KEYFRAME_TYPES.START
            ? "开始关键帧不可编辑。"
            : "该时间点已经存在关键帧。",
      });
    }

    const timeError = validateUserKeyframeTime(mask, requestedTime);
    if (timeError) {
      return createResult(false, {
        code: "invalid-time",
        error: timeError,
      });
    }

    const state = getMaskStateAtTime(maskId, requestedTime);
    const baseTransform = getMaskKeyframeTransform(keyframeInput, state || DEFAULT_TRANSFORM);
    const nextKeyframe = normalizeKeyframe(
      {
        id: keyframeInput.id || uuidv4(),
        type: MASK_KEYFRAME_TYPES.USER,
        time: requestedTime,
        ...baseTransform,
      },
      requestedTime,
      MASK_KEYFRAME_TYPES.USER
    );

    const nextMask = commitMask(maskId, {
      ...cloneMask(mask),
      keyframes: [...mask.keyframes.map(cloneKeyframe), nextKeyframe],
    });

    if (options.select !== false) {
      selectMask(maskId, nextKeyframe.id);
    }

    return createResult(true, {
      mask: nextMask,
      keyframe: nextMask?.keyframes.find((item) => item.id === nextKeyframe.id) || nextKeyframe,
    });
  };

  const upsertKeyframe = (maskId, keyframeInput = {}, options = {}) => {
    const mask = getMaskById(maskId);
    if (!mask) {
      return createResult(false, {
        code: "mask-not-found",
        error: "未找到对应的蒙版。",
      });
    }

    if (!keyframeInput?.id) {
      return createUserKeyframe(maskId, keyframeInput, options);
    }

    const currentKeyframe = mask.keyframes.find((item) => item.id === keyframeInput.id);
    if (!currentKeyframe) {
      return createUserKeyframe(maskId, keyframeInput, options);
    }

    if (currentKeyframe.type === MASK_KEYFRAME_TYPES.START && !options.allowStartEdit) {
      return createResult(false, {
        code: "start-locked",
        error: "开始关键帧不可编辑。",
      });
    }

    const nextMaskInput = cloneMask(mask);
    let nextEndStateExplicit = nextMaskInput.endStateExplicit;
    let nextKeyframe = null;

    if (currentKeyframe.type === MASK_KEYFRAME_TYPES.USER) {
      const requestedTime = Number(keyframeInput.time ?? currentKeyframe.time);
      const timeError = validateUserKeyframeTime(mask, requestedTime, currentKeyframe.id);
      if (timeError) {
        return createResult(false, {
          code: "invalid-time",
          error: timeError,
        });
      }

      nextKeyframe = normalizeKeyframe(
        {
          ...currentKeyframe,
          ...keyframeInput,
          type: MASK_KEYFRAME_TYPES.USER,
          time: requestedTime,
        },
        requestedTime,
        MASK_KEYFRAME_TYPES.USER
      );
    } else if (currentKeyframe.type === MASK_KEYFRAME_TYPES.END) {
      const nextTransform = getMaskKeyframeTransform(
        {
          ...currentKeyframe,
          ...keyframeInput,
        },
        currentKeyframe
      );

      if (
        Object.prototype.hasOwnProperty.call(keyframeInput, "x") ||
        Object.prototype.hasOwnProperty.call(keyframeInput, "y") ||
        Object.prototype.hasOwnProperty.call(keyframeInput, "scale")
      ) {
        nextEndStateExplicit = true;
      }

      nextKeyframe = normalizeKeyframe(
        {
          ...currentKeyframe,
          ...nextTransform,
          type: MASK_KEYFRAME_TYPES.END,
          time: mask.endTime,
        },
        mask.endTime,
        MASK_KEYFRAME_TYPES.END
      );
    } else {
      const nextTransform = getMaskKeyframeTransform(
        {
          ...currentKeyframe,
          ...keyframeInput,
        },
        currentKeyframe
      );

      nextKeyframe = normalizeKeyframe(
        {
          ...currentKeyframe,
          ...nextTransform,
          type: MASK_KEYFRAME_TYPES.START,
          time: mask.startTime,
        },
        mask.startTime,
        MASK_KEYFRAME_TYPES.START
      );
    }

    nextMaskInput.endStateExplicit = nextEndStateExplicit;
    nextMaskInput.keyframes = nextMaskInput.keyframes.map((item) =>
      item.id === currentKeyframe.id ? nextKeyframe : item
    );

    const committedMask = commitMask(maskId, nextMaskInput);

    if (options.select !== false) {
      selectMask(maskId, currentKeyframe.id);
    }

    return createResult(true, {
      mask: committedMask,
      keyframe:
        committedMask?.keyframes.find((item) => item.id === currentKeyframe.id) || nextKeyframe,
    });
  };

  const removeKeyframe = (maskId, keyframeId) => {
    const mask = getMaskById(maskId);
    if (!mask) {
      return createResult(false, {
        code: "mask-not-found",
        error: "未找到对应的蒙版。",
      });
    }

    const targetKeyframe = mask.keyframes.find((item) => item.id === keyframeId) || null;
    if (!targetKeyframe) {
      return createResult(false, {
        code: "keyframe-not-found",
        error: "未找到对应的关键帧。",
      });
    }

    if (targetKeyframe.type !== MASK_KEYFRAME_TYPES.USER) {
      return createResult(false, {
        code: "keyframe-locked",
        error:
          targetKeyframe.type === MASK_KEYFRAME_TYPES.END
            ? "结束关键帧不可删除。"
            : "开始关键帧不可删除。",
      });
    }

    const nextMask = commitMask(maskId, {
      ...cloneMask(mask),
      keyframes: mask.keyframes.filter((item) => item.id !== keyframeId),
    });

    if (selectedKeyframeId.value === keyframeId) {
      selectMask(maskId, null);
    }

    return createResult(true, {
      mask: nextMask,
    });
  };

  const ensureTransformKeyframeAtCurrentTime = (maskId, transformPatch = {}) => {
    const result = createUserKeyframe(
      maskId || selectedMaskId.value,
      {
        time: currentTime.value,
        ...transformPatch,
      },
      {
        reuseExisting: true,
        select: true,
      }
    );

    return result.ok ? result.keyframe : null;
  };

  const renameMask = (maskId, name) => updateMask(maskId, { name });

  const resizeMaskRange = (maskId, { startTime, endTime }, options = {}) => {
    const mask = getMaskById(maskId);
    if (!mask) {
      return createResult(false, {
        code: "mask-not-found",
        error: "未找到对应的蒙版。",
      });
    }

    const duration = Math.max(0, videoDuration.value || 0);
    const nextStart = clamp(Number(startTime ?? mask.startTime), 0, duration);
    const nextEnd = clamp(Number(endTime ?? mask.endTime), nextStart, duration);

    const overflowKeyframes = getUserKeyframes(mask).filter(
      (item) =>
        item.time <= nextStart + KEYFRAME_TOLERANCE ||
        item.time >= nextEnd - KEYFRAME_TOLERANCE
    );

    if (overflowKeyframes.length > 0 && !options.deleteOverflow) {
      return createResult(false, {
        code: "overflow-user-keyframes",
        error: "调整后的蒙版区间会删除越界关键帧。",
        overflowKeyframes,
        startTime: nextStart,
        endTime: nextEnd,
      });
    }

    const nextMask = commitMask(maskId, {
      ...cloneMask(mask),
      startTime: nextStart,
      endTime: nextEnd,
      keyframes: mask.keyframes.filter(
        (item) =>
          item.type !== MASK_KEYFRAME_TYPES.USER ||
          (item.time > nextStart + KEYFRAME_TOLERANCE &&
            item.time < nextEnd - KEYFRAME_TOLERANCE)
      ),
    });

    return createResult(true, {
      mask: nextMask,
      overflowKeyframes,
    });
  };

  const moveMaskRange = (maskId, delta) => {
    const mask = getMaskById(maskId);
    if (!mask) {
      return createResult(false, {
        code: "mask-not-found",
        error: "未找到对应的蒙版。",
      });
    }

    const requestedDelta = Number(delta || 0);
    const nextStart = Number(mask.startTime || 0) + requestedDelta;
    const nextEnd = Number(mask.endTime || 0) + requestedDelta;

    if (nextStart < -KEYFRAME_TOLERANCE) {
      return createResult(false, {
        code: "range-start-out-of-bounds",
        error: "蒙版区间不能早于视频开始时间。",
      });
    }

    if (nextEnd > Number(videoDuration.value || 0) + KEYFRAME_TOLERANCE) {
      return createResult(false, {
        code: "range-end-out-of-bounds",
        error: "蒙版区间不能超出视频结束时间。",
      });
    }

    const appliedDelta = Math.abs(requestedDelta) <= KEYFRAME_TOLERANCE ? 0 : requestedDelta;

    if (Math.abs(appliedDelta) <= KEYFRAME_TOLERANCE) {
      return createResult(true, {
        mask,
        delta: 0,
      });
    }

    const nextMask = commitMask(maskId, {
      ...cloneMask(mask),
      startTime: nextStart,
      endTime: nextEnd,
      keyframes: mask.keyframes.map((item) => ({
        ...item,
        time: Number(item.time || 0) + appliedDelta,
      })),
    });

    return createResult(true, {
      mask: nextMask,
      delta: appliedDelta,
    });
  };

  const updateMaskRange = (maskId, range, options = {}) =>
    resizeMaskRange(maskId, range, options);

  const updateMaskTool = (patch = {}) => {
    maskTool.value = cloneMaskTool({
      ...maskTool.value,
      ...patch,
    });
    runtimeUiStore.setVideoMaskDrawingEnabled(maskTool.value.drawingEnabled);
  };

  const setMaskToolDefaults = (brushDefaults = {}, options = {}) => {
    const { syncActive = true, preserveInteraction = true } = options;
    const normalized = normalizeBrushConfig(brushDefaults, DEFAULT_VIDEO_BRUSH);
    maskToolDefaults.value = { ...normalized };

    if (!syncActive) {
      return maskToolDefaults.value;
    }

    updateMaskTool({
      brushSize: normalized.size,
      brushAlpha: normalized.alpha,
      brushColor: normalized.color,
      ...(preserveInteraction
        ? {}
        : {
            drawingEnabled: false,
            mode: MASK_TOOL_MODES.DRAW,
          }),
    });

    return maskToolDefaults.value;
  };

  return {
    videoFile,
    hasVideoFile,
    playerWidth,
    playerHeight,
    isPlaying,
    isMuted,
    currentTime,
    playbackRate,
    videoWidth,
    videoHeight,
    videoDuration,
    sourceFrameRate,
    displayWidth,
    displayHeight,
    masks,
    selectedMaskId,
    selectedKeyframeId,
    maskTool,
    currentSourcePath,
    currentSourceName,
    currentSourceIsReplacement,
    videoHistory,
    selectedMask,
    selectedKeyframe,
    selectedMaskOrderedKeyframes,
    selectedMaskUserKeyframes,
    hasSelectedMask,
    canDeleteSelectedKeyframe,
    canEditSelectedKeyframeTime,
    canEditSelectedKeyframeTransform,
    hasVideoHistory,
    canOpenVideoHistory,
    canUndoSelectedMaskDraw,
    setVideoFile,
    clearVideoFile,
    resetEditorState,
    getVideoFileInfo,
    setCurrentSourceMeta,
    clearVideoHistory,
    captureEditorSnapshot,
    restoreEditorSnapshot,
    buildHistoryEntry,
    pushHistoryEntry,
    removeHistoryFrom,
    setPlayerSize,
    adjustPlayerSize,
    setIsPlaying,
    setIsMuted,
    setCurrentTime,
    setPlaybackRate,
    setVideoInfo,
    setSourceFrameRate,
    clearVideoInfo,
    calculateDisplaySize,
    createMask,
    removeMask,
    selectMask,
    selectKeyframe,
    updateMask,
    updateSelectedMask,
    setMaskBaseMask,
    setSelectedMaskBaseMask,
    commitMaskBaseMask,
    commitSelectedMaskBaseMask,
    undoMaskDraw,
    undoSelectedMaskDraw,
    createUserKeyframe,
    upsertKeyframe,
    removeKeyframe,
    updateMaskRange,
    resizeMaskRange,
    moveMaskRange,
    renameMask,
    updateMaskTool,
    setMaskToolDefaults,
    getMaskById,
    getMaskStateAtTime,
    ensureTransformKeyframeAtCurrentTime,
    ensureMasksStayInRange,
  };
});
