import {
  createDefaultShortcuts,
  normalizeShortcutConfig,
} from "../utils/shortcutConfig.js";

export const CONFIG_SCHEMA_VERSION = 15;

export const DEFAULT_THEME_MODE = "light";
export const DEFAULT_UI_BUTTON_SIZE = "sm";
export const UI_BUTTON_SIZE_OPTIONS = Object.freeze(["xs", "sm", "md"]);
export const IMAGE_PROCESSING_METHOD_OPTIONS = Object.freeze(["auto", "path", "base64"]);
export const SLBR_LOCAL_INFERENCE_STRATEGY_OPTIONS = Object.freeze([
  "auto",
  "full",
  "smart_tiles",
]);
export const VIDEO_PROCESSING_ENGINE_OPTIONS = Object.freeze(["auto", "webav", "ffmpeg"]);
export const VIDEO_INTERMEDIATE_FRAME_STRATEGY_OPTIONS = Object.freeze([
  "performance",
  "balanced",
  "quality",
]);
export const VIDEO_ENCODING_QUALITY_PRESET_OPTIONS = Object.freeze([
  "performance",
  "balanced",
  "stable",
  "highStable",
  "nearLossless",
]);
export const VIDEO_INPAINT_COLOR_STABILIZATION_OPTIONS = Object.freeze([
  "off",
  "auto",
  "enhanced",
]);
export const VIDEO_TEMPORAL_ENHANCEMENT_MODES = Object.freeze([
  "conservative",
  "balanced",
  "strong",
]);
export const IMAGE_OUTPUT_NAMING_MODES = Object.freeze(["original", "prefixUuid"]);
export const IMAGE_OUTPUT_FORMAT_OPTIONS = Object.freeze([
  "auto",
  "original",
  "png",
  "jpg",
  "webp",
]);
export const DEFAULT_IMAGE_OUTPUT_QUALITY = 95;
export const DEFAULT_MCP_PROFILE_ID = "desktop-default";
export const MCP_ALLOWED_TOOL_OPTIONS = Object.freeze([
  "moonshine.capabilities",
  "moonshine.image.process_batch",
  "moonshine.jobs.get",
  "moonshine.jobs.result",
  "moonshine.jobs.cancel",
]);
export const MAX_MCP_ALLOWED_ROOTS = 16;
export const MAX_MCP_ALLOWED_ROOT_LENGTH = 1024;

export const APP_CONFIG_INTEGER_LIMITS = Object.freeze({
  imageHistoryLimit: Object.freeze({ min: 1, max: 100 }),
  imageWarningSize: Object.freeze({ min: 1, max: 1000 }),
  stateSaveLimit: Object.freeze({ min: 10, max: 500 }),
  slbrLocalBBoxEmptyRatioThreshold: Object.freeze({ min: 1, max: 99 }),
  slbrLocalEdgeFeatherPx: Object.freeze({ min: 0, max: 16 }),
  brushSize: Object.freeze({ min: 1, max: 120 }),
  minMaskArea: Object.freeze({ min: 1, max: 1000000 }),
  batchFrameCount: Object.freeze({ min: 1 }),
});

export const DEFAULT_MANAGED_FOLDER_NAMES = Object.freeze({
  image: "images",
  video: "videos",
});

const WINDOWS_RESERVED_FOLDER_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const WINDOWS_INVALID_FOLDER_CHARACTERS = /[<>:"/\\|?*]/;
const containsControlCharacter = (value) =>
  Array.from(value).some((character) => character.charCodeAt(0) <= 31);

export const getManagedFolderNameValidationError = (value) => {
  if (typeof value !== "string") {
    return "文件夹名必须是字符串。";
  }
  if (!value || !value.trim()) {
    return "文件夹名不能为空。";
  }
  if (value === "." || value === "..") {
    return "文件夹名不能使用点文件夹。";
  }
  if (WINDOWS_INVALID_FOLDER_CHARACTERS.test(value) || containsControlCharacter(value)) {
    return "文件夹名不能包含路径分隔符或系统保留字符。";
  }
  if (/[ .]$/.test(value)) {
    return "文件夹名不能以空格或句点结尾。";
  }

  const windowsBaseName = value.split(".", 1)[0].replace(/[ .]+$/g, "");
  if (WINDOWS_RESERVED_FOLDER_NAME.test(windowsBaseName)) {
    return "文件夹名不能使用 Windows 系统保留名称。";
  }
  return "";
};

export const isValidManagedFolderName = (value) =>
  getManagedFolderNameValidationError(value) === "";

export const normalizeManagedFolderName = (value, fallback) =>
  isValidManagedFolderName(value) ? value : fallback;

export const isFiniteIntegerInRange = (value, limits = {}) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  Number.isInteger(value) &&
  (limits.min === undefined || value >= limits.min) &&
  (limits.max === undefined || value <= limits.max);

export const normalizeIntegerInRange = (value, fallback, limits = {}) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const rounded = Math.round(numeric);
  const minimum = limits.min ?? Number.NEGATIVE_INFINITY;
  const maximum = limits.max ?? Number.POSITIVE_INFINITY;
  return Math.min(maximum, Math.max(minimum, rounded));
};

export const DEFAULT_BRAND_COLORS = Object.freeze({
  primary: "#8a71d4",
  secondary: "#c1bee6",
  accent: "#e6cfad",
  positive: "#189e7a",
  negative: "#cc455d",
  info: "#7a8dbe",
  warning: "#e6ac00",
});

export const DEFAULT_IMAGE_BRUSH = Object.freeze({
  size: 20,
  color: "#8a71d4",
  alpha: 0.75,
});

export const DEFAULT_VIDEO_BRUSH = Object.freeze({
  size: 24,
  color: DEFAULT_IMAGE_BRUSH.color,
  alpha: 0.75,
});

export const DEFAULT_TEMP_CLEANUP = Object.freeze({
  enabled: false,
  onStartup: false,
  maxAgeDays: 7,
  includeImages: true,
  includeVideos: true,
  keepRecentFailures: true,
});

export const DEFAULT_VIDEO_TEMPORAL_ENHANCEMENT = Object.freeze({
  enabled: false,
  mode: "conservative",
  stabilizeMask: true,
  stabilizeResult: true,
  textureCache: true,
  diagnostics: false,
  sceneChangeThreshold: 0.35,
  maskIouThreshold: 0.45,
  centerShiftThreshold: 0.08,
  blendStrength: 0.25,
  cacheTtlFrames: 12,
  minMaskArea: 16,
});

export const DEFAULT_MASKING_CONFIG = Object.freeze({
  defaultSamModel: "sam_vit_b",
  defaultSam1Model: "sam_vit_b",
  defaultSam2Model: "sam2_1_hiera_large",
  defaultSam3Model: "sam3_1_multiplex",
  imageSmartSelectionDefaultModel: "sam_vit_b",
  videoSmartSelectionDefaultModel: "sam2_1_hiera_large",
  samRenderCacheEnabled: true,
  samRenderCacheMaxContexts: 12,
  samRenderCacheMaxMemoryMb: 192,
  samRenderCacheLargeImageLongSide: 4096,
  samLazyRenderDisabledCandidates: true,
  samRenderCachePreloadVisibleList: true,
  samRenderCacheNeighborPreloadCount: 4,
  samReleaseBeforeProcessing: true,
  ocrConfidenceHigh: 0.9,
  ocrConfidenceLow: 0.8,
  ocrSamEnhance: false,
  ocrSamModelId: "",
});

export const DEFAULT_MCP_CONFIG = Object.freeze({
  enabled: false,
  profileId: DEFAULT_MCP_PROFILE_ID,
  allowedTools: Object.freeze([]),
  allowedRoots: Object.freeze([]),
  confirmationRequired: true,
});
export const MCP_CONFIG_FIELD_NAMES = Object.freeze([
  "enabled",
  "profileId",
  "allowedTools",
  "allowedRoots",
  "confirmationRequired",
]);

const MCP_PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MCP_TOKEN_MATERIAL_KEY_FRAGMENTS = Object.freeze([
  "token",
  "authorization",
  "secret",
  "apikey",
  "password",
  "credential",
]);
const WINDOWS_UNSAFE_MCP_ROOT = /^(?:\\\\[?.]|\\\\\.|\\\\|\/\/)/;
const MCP_ABSOLUTE_ROOT = /^(?:[A-Za-z]:[\\/]|\/(?!\/))/;

const hasControlCharacter = (value) =>
  Array.from(value).some((character) => character.charCodeAt(0) <= 31);

const normalizeMcpTokenKey = (value) =>
  String(value || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();

const isMcpTokenMaterialKey = (value) => {
  const normalized = normalizeMcpTokenKey(value);
  return MCP_TOKEN_MATERIAL_KEY_FRAGMENTS.some(
    (fragment) =>
      normalized === fragment || normalized.startsWith(fragment) || normalized.endsWith(fragment)
  );
};

export const isValidMcpProfileId = (value) =>
  typeof value === "string" && MCP_PROFILE_ID_PATTERN.test(value.trim());

export const normalizeMcpProfileId = (value) => {
  const profileId = typeof value === "string" ? value.trim() : "";
  return isValidMcpProfileId(profileId) ? profileId : DEFAULT_MCP_PROFILE_ID;
};

export const isSafeMcpAllowedRoot = (value) => {
  if (typeof value !== "string") return false;
  const root = value.trim();
  if (!root || root.length > MAX_MCP_ALLOWED_ROOT_LENGTH || hasControlCharacter(root)) return false;
  if (WINDOWS_UNSAFE_MCP_ROOT.test(root) || !MCP_ABSOLUTE_ROOT.test(root)) return false;
  return !/(?:^|[\\/])\.{1,2}(?:[\\/]|$)/.test(root);
};

export const normalizeMcpAllowedRoots = (value) => {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const roots = [];
  for (const candidate of value) {
    const root = typeof candidate === "string" ? candidate.trim() : "";
    if (!isSafeMcpAllowedRoot(root)) continue;
    const key = /^[A-Za-z]:/.test(root) ? root.replaceAll("\\", "/").toLowerCase() : root;
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(root);
    if (roots.length === MAX_MCP_ALLOWED_ROOTS) break;
  }
  return roots;
};

export const normalizeMcpAllowedTools = (value) => {
  const requested = new Set(Array.isArray(value) ? value.filter((tool) => typeof tool === "string") : []);
  return MCP_ALLOWED_TOOL_OPTIONS.filter((tool) => requested.has(tool));
};

export const containsMcpTokenMaterial = (value, seen = new Set()) => {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsMcpTokenMaterial(item, seen));
  return Object.entries(value).some(([key, item]) =>
    isMcpTokenMaterialKey(key) || containsMcpTokenMaterial(item, seen)
  );
};

export const normalizeMcpConfigMetadata = (value = {}) => {
  const config = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    enabled: typeof config.enabled === "boolean" ? config.enabled : DEFAULT_MCP_CONFIG.enabled,
    profileId: normalizeMcpProfileId(config.profileId),
    allowedTools: normalizeMcpAllowedTools(config.allowedTools),
    allowedRoots: normalizeMcpAllowedRoots(config.allowedRoots),
    confirmationRequired:
      typeof config.confirmationRequired === "boolean"
        ? config.confirmationRequired
        : DEFAULT_MCP_CONFIG.confirmationRequired,
  };
};

export const createDefaultAppConfig = () => ({
  schemaVersion: CONFIG_SCHEMA_VERSION,
  general: {
    backendPort: 8080,
    launchMode: "cuda",
    modelDir: "",
    backendProjectPath: "",
    defaultModel: "lama",
    autoStart: true,
    language: "zh-CN",
    closeBehavior: "tray",
    confirmBeforeQuit: true,
  },
  fileManagement: {
    downloadPath: "",
    tempPath: "",
    imageFolderName: DEFAULT_MANAGED_FOLDER_NAMES.image,
    videoFolderName: DEFAULT_MANAGED_FOLDER_NAMES.video,
    tempCleanup: { ...DEFAULT_TEMP_CLEANUP },
  },
  advanced: {
    imageHistoryLimit: 10,
    imageWarningSize: 50,
    stateSaveLimit: 100,
    imageProcessingMethod: "auto",
    slbrLocalInferenceStrategy: "auto",
    slbrLocalBBoxEmptyRatioThreshold: 50,
    slbrLocalEdgeFeatherPx: 2,
    imageOutputFormat: "auto",
    imageOutputQuality: DEFAULT_IMAGE_OUTPUT_QUALITY,
    imageOutputNamingMode: "original",
    imageOutputFixedPrefix: "moonshine",
    videoProcessingEngine: "auto",
    imageBrushDefault: { ...DEFAULT_IMAGE_BRUSH },
    videoBrushDefault: { ...DEFAULT_VIDEO_BRUSH },
  },
  masking: {
    ...DEFAULT_MASKING_CONFIG,
  },
  mcp: {
    ...DEFAULT_MCP_CONFIG,
    allowedTools: [...DEFAULT_MCP_CONFIG.allowedTools],
    allowedRoots: [...DEFAULT_MCP_CONFIG.allowedRoots],
  },
  ui: {
    theme: DEFAULT_THEME_MODE,
    buttonSize: DEFAULT_UI_BUTTON_SIZE,
    brandColors: { ...DEFAULT_BRAND_COLORS },
    showStartupAnimation: true,
    showWelcomeDialog: true,
    confirmBeforeExit: true,
    autoSaveInterval: 30000,
  },
  shortcuts: createDefaultShortcuts(),
  video: {
    intermediateFrameStrategy: "performance",
    encodingQualityPreset: "performance",
    inpaintColorStabilization: "auto",
    frameExtractionFormat: "jpg",
    batchFrameCount: 120,
    historyLimit: 5,
    defaultFrameRate: 30,
    maxKeyframes: 100,
    autoNextFrameInterval: 0.1,
    tempFramesPath: "",
    supportedFormats: ["mp4", "mov", "avi", "mkv", "wmv"],
    maxConcurrentFrameProcessing: 4,
    enableFrameSkipping: true,
    memoryOptimization: true,
    autoSaveInterval: 30,
    maxDraftRetention: 7,
    batchRetryCount: 3,
    failureRetentionCount: 3,
    proxyMaxSide: 1280,
    previewTrialSeconds: 3,
    temporalEnhancement: { ...DEFAULT_VIDEO_TEMPORAL_ENHANCEMENT },
  },
});

export const DEFAULT_APP_CONFIG = Object.freeze(createDefaultAppConfig());

export const cloneConfig = (value) => JSON.parse(JSON.stringify(value));

export const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const isTypeCompatible = (defaultValue, candidateValue) => {
  if (candidateValue === undefined) return false;
  if (Array.isArray(defaultValue)) return Array.isArray(candidateValue);
  if (isPlainObject(defaultValue)) return isPlainObject(candidateValue);
  if (typeof defaultValue === "number") {
    return typeof candidateValue === "number" && !Number.isNaN(candidateValue);
  }
  return typeof candidateValue === typeof defaultValue;
};

export const alignConfigWithDefaultSchema = (defaultValue, candidateValue) => {
  const defaultClone = cloneConfig(defaultValue);

  if (Array.isArray(defaultValue)) {
    return Array.isArray(candidateValue) ? cloneConfig(candidateValue) : defaultClone;
  }

  if (isPlainObject(defaultValue)) {
    if (!isPlainObject(candidateValue)) {
      return defaultClone;
    }

    return Object.keys(defaultValue).reduce((result, key) => {
      result[key] = alignConfigWithDefaultSchema(defaultValue[key], candidateValue[key]);
      return result;
    }, {});
  }

  return isTypeCompatible(defaultValue, candidateValue)
    ? cloneConfig(candidateValue)
    : defaultClone;
};

export const migrateLegacyConfigShape = (rawConfig = {}) => {
  if (!isPlainObject(rawConfig)) {
    return {};
  }

  if (!rawConfig.general && typeof rawConfig.apiPort === "number") {
    return {
      general: {
        backendPort: rawConfig.apiPort,
      },
    };
  }

  const migrated = cloneConfig(rawConfig);
  const legacySchemaVersion = Number(migrated.schemaVersion || 0);

  if (isPlainObject(migrated.general)) {
    const legacyModelPath = String(migrated.general.modelPath || "").trim();
    const modelDir = String(migrated.general.modelDir || "").trim();
    if (!modelDir && legacyModelPath) {
      migrated.general.modelDir = legacyModelPath;
    }
    delete migrated.general.modelPath;

    const hasCloseBehavior = Object.prototype.hasOwnProperty.call(
      migrated.general,
      "closeBehavior"
    );
    if (!hasCloseBehavior) {
      // Existing configurations closed the application. Keep that behavior for
      // migrated installs while new installs receive the tray default.
      const hasLegacyExitPreference =
        isPlainObject(migrated.ui) &&
        typeof migrated.ui.confirmBeforeExit === "boolean";
      migrated.general.closeBehavior =
        (Number.isFinite(legacySchemaVersion) && legacySchemaVersion > 0 && legacySchemaVersion < 15) ||
        hasLegacyExitPreference
          ? "quit"
          : "tray";
    }
    if (
      !Object.prototype.hasOwnProperty.call(migrated.general, "confirmBeforeQuit") &&
      isPlainObject(migrated.ui) &&
      typeof migrated.ui.confirmBeforeExit === "boolean"
    ) {
      migrated.general.confirmBeforeQuit = migrated.ui.confirmBeforeExit;
    }
  }

  if (isPlainObject(migrated.fileManagement)) {
    const hasAutoCleanTemp = Object.prototype.hasOwnProperty.call(
      migrated.fileManagement,
      "autoCleanTemp"
    );
    if (hasAutoCleanTemp) {
      migrated.fileManagement.tempCleanup = {
        ...(isPlainObject(migrated.fileManagement.tempCleanup)
          ? migrated.fileManagement.tempCleanup
          : {}),
        enabled: migrated.fileManagement.autoCleanTemp === true,
      };
      delete migrated.fileManagement.autoCleanTemp;
    }

    migrated.fileManagement.imageFolderName = normalizeManagedFolderName(
      migrated.fileManagement.imageFolderName,
      DEFAULT_MANAGED_FOLDER_NAMES.image
    );
    migrated.fileManagement.videoFolderName = normalizeManagedFolderName(
      migrated.fileManagement.videoFolderName,
      DEFAULT_MANAGED_FOLDER_NAMES.video
    );
  }

  if (
    (!Number.isFinite(legacySchemaVersion) || legacySchemaVersion < 12) &&
    isPlainObject(migrated.video) &&
    !VIDEO_INTERMEDIATE_FRAME_STRATEGY_OPTIONS.includes(
      migrated.video.intermediateFrameStrategy
    )
  ) {
    migrated.video.intermediateFrameStrategy = "performance";
  }
  if (
    (!Number.isFinite(legacySchemaVersion) || legacySchemaVersion < 12) &&
    isPlainObject(migrated.video) &&
    !VIDEO_ENCODING_QUALITY_PRESET_OPTIONS.includes(migrated.video.encodingQualityPreset)
  ) {
    migrated.video.encodingQualityPreset = "performance";
  }
  if (
    (!Number.isFinite(legacySchemaVersion) || legacySchemaVersion < 13) &&
    isPlainObject(migrated.video) &&
    !VIDEO_INPAINT_COLOR_STABILIZATION_OPTIONS.includes(
      migrated.video.inpaintColorStabilization
    )
  ) {
    migrated.video.inpaintColorStabilization = "auto";
  }

  return migrated;
};

export const normalizeConfigToCurrentSchema = (rawConfig = {}) => {
  const defaultConfig = createDefaultAppConfig();
  const migrated = migrateLegacyConfigShape(rawConfig);
  const aligned = alignConfigWithDefaultSchema(defaultConfig, migrated);
  aligned.schemaVersion = CONFIG_SCHEMA_VERSION;
  if (!String(aligned.masking?.defaultSamModel || "").trim()) {
    aligned.masking.defaultSamModel = DEFAULT_MASKING_CONFIG.defaultSamModel;
  }
  if (!String(aligned.masking?.defaultSam1Model || "").trim()) {
    aligned.masking.defaultSam1Model = aligned.masking.defaultSamModel;
  }
  if (!String(aligned.masking?.defaultSam2Model || "").trim()) {
    aligned.masking.defaultSam2Model = DEFAULT_MASKING_CONFIG.defaultSam2Model;
  }
  if (!String(aligned.masking?.defaultSam3Model || "").trim()) {
    aligned.masking.defaultSam3Model = DEFAULT_MASKING_CONFIG.defaultSam3Model;
  }
  if (!String(aligned.masking?.imageSmartSelectionDefaultModel || "").trim()) {
    aligned.masking.imageSmartSelectionDefaultModel =
      aligned.masking.defaultSamModel ||
      aligned.masking.defaultSam1Model ||
      DEFAULT_MASKING_CONFIG.imageSmartSelectionDefaultModel;
  }
  if (!String(aligned.masking?.videoSmartSelectionDefaultModel || "").trim()) {
    aligned.masking.videoSmartSelectionDefaultModel =
      aligned.masking.defaultSam2Model ||
      DEFAULT_MASKING_CONFIG.videoSmartSelectionDefaultModel;
  }
  aligned.mcp = normalizeMcpConfigMetadata(aligned.mcp);
  aligned.shortcuts = normalizeShortcutConfig(aligned.shortcuts);
  return aligned;
};

export const needsConfigMigration = (rawConfig = {}) => {
  if (!isPlainObject(rawConfig)) {
    return true;
  }
  const version = Number(rawConfig.schemaVersion || 0);
  if (!Number.isFinite(version) || version < CONFIG_SCHEMA_VERSION) {
    return true;
  }

  const normalized = normalizeConfigToCurrentSchema(rawConfig);
  return JSON.stringify(normalized) !== JSON.stringify(rawConfig);
};
