import {
  createDefaultShortcuts,
  normalizeShortcutConfig,
} from "../utils/shortcutConfig.js";

export const CONFIG_SCHEMA_VERSION = 8;

export const DEFAULT_THEME_MODE = "light";
export const DEFAULT_UI_BUTTON_SIZE = "sm";
export const UI_BUTTON_SIZE_OPTIONS = Object.freeze(["xs", "sm", "md"]);
export const IMAGE_PROCESSING_METHOD_OPTIONS = Object.freeze(["auto", "path", "base64"]);
export const VIDEO_PROCESSING_ENGINE_OPTIONS = Object.freeze(["auto", "webav", "ffmpeg"]);
export const IMAGE_OUTPUT_NAMING_MODES = Object.freeze(["original", "prefixUuid"]);
export const IMAGE_OUTPUT_FORMAT_OPTIONS = Object.freeze([
  "auto",
  "original",
  "png",
  "jpg",
  "webp",
]);
export const DEFAULT_IMAGE_OUTPUT_QUALITY = 95;

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
});

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
  },
  fileManagement: {
    downloadPath: "",
    tempPath: "",
    imageFolderName: "images",
    videoFolderName: "videos",
    tempCleanup: { ...DEFAULT_TEMP_CLEANUP },
  },
  advanced: {
    imageHistoryLimit: 10,
    imageWarningSize: 50,
    stateSaveLimit: 100,
    imageProcessingMethod: "auto",
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

  if (isPlainObject(migrated.general)) {
    const legacyModelPath = String(migrated.general.modelPath || "").trim();
    const modelDir = String(migrated.general.modelDir || "").trim();
    if (!modelDir && legacyModelPath) {
      migrated.general.modelDir = legacyModelPath;
    }
    delete migrated.general.modelPath;
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
