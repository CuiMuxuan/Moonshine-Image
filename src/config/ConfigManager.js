import {
  normalizeShortcutConfig,
  validateShortcutConfig,
} from "src/utils/shortcutConfig";
import {
  alignConfigWithDefaultSchema,
  CONFIG_SCHEMA_VERSION,
  createDefaultAppConfig,
  DEFAULT_APP_CONFIG,
  DEFAULT_BRAND_COLORS,
  DEFAULT_IMAGE_BRUSH,
  DEFAULT_IMAGE_OUTPUT_QUALITY,
  DEFAULT_TEMP_CLEANUP,
  DEFAULT_THEME_MODE,
  DEFAULT_UI_BUTTON_SIZE,
  DEFAULT_VIDEO_BRUSH,
  IMAGE_PROCESSING_METHOD_OPTIONS,
  IMAGE_OUTPUT_FORMAT_OPTIONS,
  IMAGE_OUTPUT_NAMING_MODES,
  isPlainObject,
  isTypeCompatible,
  migrateLegacyConfigShape,
  UI_BUTTON_SIZE_OPTIONS,
  VIDEO_PROCESSING_ENGINE_OPTIONS,
} from "src/shared/appConfigSchema";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const isValidHexColor = (value) =>
  /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(value || "").trim());

const normalizeHexColor = (value, fallback) => {
  const candidate = String(value || "").trim();
  return isValidHexColor(candidate) ? candidate : fallback;
};

const normalizeBrushConfig = (brush = {}, fallback = DEFAULT_IMAGE_BRUSH) => ({
  size: Math.max(1, Math.round(Number(brush.size ?? fallback.size) || fallback.size)),
  color: normalizeHexColor(brush.color, fallback.color),
  alpha: clamp(Number(brush.alpha ?? fallback.alpha) || fallback.alpha, 0.05, 1),
});

const normalizeBrandColors = (colors = {}) =>
  Object.keys(DEFAULT_BRAND_COLORS).reduce((result, key) => {
    result[key] = normalizeHexColor(colors?.[key], DEFAULT_BRAND_COLORS[key]);
    return result;
  }, {});

const normalizeThemeMode = (theme) =>
  ["light", "dark"].includes(theme) ? theme : DEFAULT_THEME_MODE;

const normalizeButtonSize = (value) =>
  UI_BUTTON_SIZE_OPTIONS.includes(value) ? value : DEFAULT_UI_BUTTON_SIZE;

const normalizeBoolean = (value, fallback = true) =>
  typeof value === "boolean" ? value : fallback;

const normalizeModelPath = (value) => {
  const normalized = String(value || "").trim().replace(/\\/g, "/");
  if (!normalized || normalized.endsWith("/.cache/torch/hub/checkpoints")) {
    return "";
  }
  return value;
};

const normalizeInteger = (value, fallback, min, max = Number.MAX_SAFE_INTEGER) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return clamp(Math.round(numeric), min, max);
};

export {
  DEFAULT_BRAND_COLORS,
  CONFIG_SCHEMA_VERSION,
  DEFAULT_IMAGE_BRUSH,
  DEFAULT_THEME_MODE,
  DEFAULT_UI_BUTTON_SIZE,
  DEFAULT_VIDEO_BRUSH,
  DEFAULT_TEMP_CLEANUP,
  DEFAULT_IMAGE_OUTPUT_QUALITY,
  IMAGE_PROCESSING_METHOD_OPTIONS,
  IMAGE_OUTPUT_FORMAT_OPTIONS,
  IMAGE_OUTPUT_NAMING_MODES,
  VIDEO_PROCESSING_ENGINE_OPTIONS,
  normalizeBrandColors,
  normalizeBrushConfig,
  normalizeButtonSize,
  normalizeThemeMode,
  UI_BUTTON_SIZE_OPTIONS,
};

export class ConfigManager {
  static defaultConfig = DEFAULT_APP_CONFIG;

  static validateConfig(config) {
    const errors = [];

    if (
      !config.general?.backendPort ||
      config.general.backendPort < 1024 ||
      config.general.backendPort > 65535
    ) {
      errors.push("后端端口必须在 1024-65535 范围内。");
    }

    if (!["cuda", "cpu"].includes(config.general?.launchMode)) {
      errors.push("启动方式必须是 cuda 或 cpu。");
    }

    if (
      config.general?.backendProjectPath &&
      typeof config.general.backendProjectPath !== "string"
    ) {
      errors.push("后端项目路径必须是字符串。");
    }

    const numberFields = [
      {
        value: config.advanced?.imageHistoryLimit,
        name: "图片历史记录上限",
        min: 1,
      },
      {
        value: config.advanced?.imageWarningSize,
        name: "图片警告大小",
        min: 1,
      },
      {
        value: config.advanced?.stateSaveLimit,
        name: "状态保存上限大小",
        min: 10,
      },
    ];

    numberFields.forEach((field) => {
      if (typeof field.value !== "number" || Number.isNaN(field.value) || field.value < field.min) {
        errors.push(`${field.name}必须大于等于 ${field.min}。`);
      }
      if (field.max && field.value > field.max) {
        errors.push(`${field.name}不能超过 ${field.max}。`);
      }
    });

    if (
      config.advanced?.imageProcessingMethod &&
      !IMAGE_PROCESSING_METHOD_OPTIONS.includes(config.advanced.imageProcessingMethod)
    ) {
      errors.push("图片处理方式必须是 auto、path 或 base64。");
    }

    if (
      config.advanced?.imageOutputFormat &&
      !IMAGE_OUTPUT_FORMAT_OPTIONS.includes(config.advanced.imageOutputFormat)
    ) {
      errors.push("图片输出格式无效。");
    }

    if (
      typeof config.advanced?.imageOutputQuality !== "number" ||
      Number.isNaN(config.advanced.imageOutputQuality) ||
      !Number.isInteger(config.advanced.imageOutputQuality) ||
      config.advanced.imageOutputQuality < 1 ||
      config.advanced.imageOutputQuality > 100
    ) {
      errors.push("图片输出质量必须是 1-100 范围内的整数。");
    }

    if (
      config.advanced?.imageOutputNamingMode &&
      !IMAGE_OUTPUT_NAMING_MODES.includes(config.advanced.imageOutputNamingMode)
    ) {
      errors.push("图片输出文件命名方式无效。");
    }

    if (!String(config.advanced?.imageOutputFixedPrefix || "").trim()) {
      errors.push("图片输出固定前缀不能为空。");
    }

    if (
      config.advanced?.videoProcessingEngine &&
      !VIDEO_PROCESSING_ENGINE_OPTIONS.includes(config.advanced.videoProcessingEngine)
    ) {
      errors.push("视频处理引擎必须是 auto、webav 或 ffmpeg。");
    }

    if (!["light", "dark"].includes(config.ui?.theme)) {
      errors.push("主题模式必须是 light 或 dark。");
    }

    if (!UI_BUTTON_SIZE_OPTIONS.includes(config.ui?.buttonSize)) {
      errors.push("按钮大小必须是 xs、sm 或 md。");
    }

    Object.keys(DEFAULT_BRAND_COLORS).forEach((key) => {
      if (!isValidHexColor(config.ui?.brandColors?.[key])) {
        errors.push(`主题颜色 ${key} 必须是有效的 Hex 颜色。`);
      }
    });

    const tempCleanup = config.fileManagement?.tempCleanup || {};
    const tempCleanupKeys = Object.keys(tempCleanup);
    if (
      tempCleanupKeys.length !== Object.keys(DEFAULT_TEMP_CLEANUP).length ||
      tempCleanupKeys.some(
        (key) => !Object.prototype.hasOwnProperty.call(DEFAULT_TEMP_CLEANUP, key)
      )
    ) {
      errors.push("临时文件清理配置包含无效字段。");
    }
    [
      { key: "enabled", name: "启用临时文件自动清理" },
      { key: "onStartup", name: "启动时清理临时文件" },
      { key: "includeImages", name: "清理图片临时文件" },
      { key: "includeVideos", name: "清理视频临时文件" },
      { key: "keepRecentFailures", name: "保留最近失败现场" },
    ].forEach(({ key, name }) => {
      if (typeof tempCleanup[key] !== "boolean") {
        errors.push(`${name}必须是布尔值。`);
      }
    });
    if (
      typeof tempCleanup.maxAgeDays !== "number" ||
      Number.isNaN(tempCleanup.maxAgeDays) ||
      !Number.isInteger(tempCleanup.maxAgeDays) ||
      tempCleanup.maxAgeDays < 1 ||
      tempCleanup.maxAgeDays > 365
    ) {
      errors.push("临时文件保留天数必须是 1-365 范围内的整数。");
    }

    [
      { value: config.advanced?.imageBrushDefault, name: "图片默认画笔" },
      { value: config.advanced?.videoBrushDefault, name: "视频默认画笔" },
    ].forEach(({ value, name }) => {
      if (!value || typeof value !== "object") {
        errors.push(`${name}配置缺失。`);
        return;
      }

      if (typeof value.size !== "number" || Number.isNaN(value.size) || value.size < 1) {
        errors.push(`${name}的大小必须大于等于 1。`);
      }

      if (typeof value.alpha !== "number" || Number.isNaN(value.alpha)) {
        errors.push(`${name}的透明度必须是数字。`);
      } else if (value.alpha < 0.05 || value.alpha > 1) {
        errors.push(`${name}的透明度必须在 0.05-1 范围内。`);
      }

      if (!isValidHexColor(value.color)) {
        errors.push(`${name}的颜色必须是有效的 Hex 颜色。`);
      }
    });

    const video = config.video || {};
    const videoFields = [
      { key: "batchFrameCount", min: 1, name: "视频固定批次帧数" },
      { key: "historyLimit", min: 1, max: 50, name: "视频历史记录上限" },
      { key: "batchRetryCount", min: 1, max: 10, name: "视频批次重试次数" },
      {
        key: "failureRetentionCount",
        min: 1,
        max: 50,
        name: "失败现场保留数量",
      },
      { key: "proxyMaxSide", min: 256, max: 4096, name: "代理预览最大边长" },
    ];

    videoFields.forEach((field) => {
      const value = video[field.key];
      if (typeof value !== "number" || Number.isNaN(value)) {
        errors.push(`${field.name}必须是数字。`);
        return;
      }
      if (value < field.min) {
        errors.push(`${field.name}必须大于等于 ${field.min}。`);
        return;
      }
      if (field.max !== undefined && value > field.max) {
        errors.push(`${field.name}必须在 ${field.min}-${field.max} 范围内。`);
      }
    });

    if (
      video.frameExtractionFormat &&
      !["jpg", "jpeg", "png", "webp"].includes(
        String(video.frameExtractionFormat).toLowerCase()
      )
    ) {
      errors.push("视频拆帧格式仅支持 jpg、jpeg、png 或 webp。");
    }

    if (
      video.previewTrialSeconds !== undefined &&
      ![3, 10].includes(Number(video.previewTrialSeconds))
    ) {
      errors.push("视频样片试跑时长仅支持 3 秒或 10 秒。");
    }

    errors.push(...validateShortcutConfig(config.shortcuts));

    return errors;
  }

  static mergeWithDefault(userConfig) {
    if (
      userConfig &&
      typeof userConfig === "object" &&
      !userConfig.general &&
      typeof userConfig.apiPort === "number"
    ) {
      userConfig = migrateLegacyConfigShape(userConfig);
    }

    const merged = this.alignWithDefaultSchema(
      createDefaultAppConfig(),
      migrateLegacyConfigShape(userConfig || {})
    );
    merged.schemaVersion = CONFIG_SCHEMA_VERSION;

    if (merged?.video && Object.prototype.hasOwnProperty.call(merged.video, "outputPath")) {
      delete merged.video.outputPath;
    }
    if (merged?.video && Object.prototype.hasOwnProperty.call(merged.video, "maxFrameCount")) {
      delete merged.video.maxFrameCount;
    }

    merged.general = {
      ...merged.general,
      backendPort: normalizeInteger(merged.general?.backendPort, 8080, 1024, 65535),
      launchMode: ["cuda", "cpu"].includes(merged.general?.launchMode)
        ? merged.general.launchMode
        : "cuda",
      modelPath: normalizeModelPath(merged.general?.modelPath) || this.defaultConfig.general.modelPath,
      autoStart: normalizeBoolean(merged.general?.autoStart, true),
    };

    merged.ui = {
      ...merged.ui,
      theme: normalizeThemeMode(merged.ui?.theme),
      buttonSize: normalizeButtonSize(merged.ui?.buttonSize),
      brandColors: normalizeBrandColors(merged.ui?.brandColors),
      showStartupAnimation: normalizeBoolean(merged.ui?.showStartupAnimation, true),
    };

    merged.fileManagement = {
      ...merged.fileManagement,
      tempCleanup: {
        enabled: normalizeBoolean(
          merged.fileManagement?.tempCleanup?.enabled,
          DEFAULT_TEMP_CLEANUP.enabled
        ),
        onStartup: normalizeBoolean(
          merged.fileManagement?.tempCleanup?.onStartup,
          DEFAULT_TEMP_CLEANUP.onStartup
        ),
        maxAgeDays: normalizeInteger(
          merged.fileManagement?.tempCleanup?.maxAgeDays,
          DEFAULT_TEMP_CLEANUP.maxAgeDays,
          1,
          365
        ),
        includeImages: normalizeBoolean(
          merged.fileManagement?.tempCleanup?.includeImages,
          DEFAULT_TEMP_CLEANUP.includeImages
        ),
        includeVideos: normalizeBoolean(
          merged.fileManagement?.tempCleanup?.includeVideos,
          DEFAULT_TEMP_CLEANUP.includeVideos
        ),
        keepRecentFailures: normalizeBoolean(
          merged.fileManagement?.tempCleanup?.keepRecentFailures,
          DEFAULT_TEMP_CLEANUP.keepRecentFailures
        ),
      },
    };

    merged.advanced = {
      ...merged.advanced,
      imageProcessingMethod: IMAGE_PROCESSING_METHOD_OPTIONS.includes(
        merged.advanced?.imageProcessingMethod
      )
        ? merged.advanced.imageProcessingMethod
        : "auto",
      imageOutputFormat: IMAGE_OUTPUT_FORMAT_OPTIONS.includes(
        String(merged.advanced?.imageOutputFormat || "").toLowerCase()
      )
        ? String(merged.advanced.imageOutputFormat).toLowerCase()
        : "auto",
      imageOutputQuality: normalizeInteger(
        merged.advanced?.imageOutputQuality,
        DEFAULT_IMAGE_OUTPUT_QUALITY,
        1,
        100
      ),
      imageOutputNamingMode: IMAGE_OUTPUT_NAMING_MODES.includes(
        merged.advanced?.imageOutputNamingMode
      )
        ? merged.advanced.imageOutputNamingMode
        : "original",
      imageOutputFixedPrefix:
        String(merged.advanced?.imageOutputFixedPrefix || "moonshine").trim() || "moonshine",
      videoProcessingEngine: VIDEO_PROCESSING_ENGINE_OPTIONS.includes(
        merged.advanced?.videoProcessingEngine
      )
        ? merged.advanced.videoProcessingEngine
        : "auto",
      imageBrushDefault: normalizeBrushConfig(
        merged.advanced?.imageBrushDefault,
        DEFAULT_IMAGE_BRUSH
      ),
      videoBrushDefault: normalizeBrushConfig(
        merged.advanced?.videoBrushDefault,
        DEFAULT_VIDEO_BRUSH
      ),
    };

    merged.video = {
      ...merged.video,
      historyLimit: normalizeInteger(merged.video?.historyLimit, 5, 1, 50),
      batchFrameCount: normalizeInteger(merged.video?.batchFrameCount, 120, 1),
      batchRetryCount: normalizeInteger(merged.video?.batchRetryCount, 3, 1, 10),
      failureRetentionCount: normalizeInteger(merged.video?.failureRetentionCount, 3, 1, 50),
      proxyMaxSide: normalizeInteger(merged.video?.proxyMaxSide, 1280, 256, 4096),
      previewTrialSeconds: [3, 10].includes(Number(merged.video?.previewTrialSeconds))
        ? Number(merged.video.previewTrialSeconds)
        : 3,
      frameExtractionFormat: ["jpg", "jpeg", "png", "webp"].includes(
        String(merged.video?.frameExtractionFormat || "").toLowerCase()
      )
        ? String(merged.video.frameExtractionFormat).toLowerCase()
        : "jpg",
    };

    merged.shortcuts = normalizeShortcutConfig(merged.shortcuts);

    return merged;
  }

  static mergeForStrictValidation(userConfig) {
    const merged = this.mergeWithDefault(userConfig || {});
    if (this.isPlainObject(userConfig?.advanced)) {
      merged.advanced = {
        ...merged.advanced,
        ...userConfig.advanced,
      };
    }
    if (this.isPlainObject(userConfig?.video)) {
      merged.video = {
        ...merged.video,
        ...userConfig.video,
      };
    }
    if (this.isPlainObject(userConfig?.general)) {
      merged.general = {
        ...merged.general,
        ...userConfig.general,
      };
    }
    if (this.isPlainObject(userConfig?.fileManagement)) {
      merged.fileManagement = {
        ...merged.fileManagement,
        ...userConfig.fileManagement,
      };
    }
    return merged;
  }

  static deepMerge(target, source) {
    const result = { ...target };

    for (const key in source) {
      if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
        result[key] = this.deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }

    return result;
  }

  static isPlainObject(value) {
    return isPlainObject(value);
  }

  static isTypeCompatible(defaultValue, candidateValue) {
    return isTypeCompatible(defaultValue, candidateValue);
  }

  static alignWithDefaultSchema(defaultValue, candidateValue) {
    return alignConfigWithDefaultSchema(defaultValue, candidateValue);
  }
}
