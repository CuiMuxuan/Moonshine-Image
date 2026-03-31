const DEFAULT_THEME_MODE = "light";
const DEFAULT_UI_BUTTON_SIZE = "sm";
const UI_BUTTON_SIZE_OPTIONS = Object.freeze(["xs", "sm", "md"]);

const DEFAULT_BRAND_COLORS = Object.freeze({
  primary: "#7758c4",
  secondary: "#2679a6",
  accent: "#9C27B0",
});

const DEFAULT_IMAGE_BRUSH = Object.freeze({
  size: 20,
  color: "#1976D2",
  alpha: 0.75,
});

const DEFAULT_VIDEO_BRUSH = Object.freeze({
  size: 24,
  color: DEFAULT_IMAGE_BRUSH.color,
  alpha: 0.75,
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const isValidHexColor = (value) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(value || "").trim());

const normalizeHexColor = (value, fallback) => {
  const candidate = String(value || "").trim();
  return isValidHexColor(candidate) ? candidate : fallback;
};

const normalizeBrushConfig = (brush = {}, fallback = DEFAULT_IMAGE_BRUSH) => ({
  size: Math.max(1, Math.round(Number(brush.size ?? fallback.size) || fallback.size)),
  color: normalizeHexColor(brush.color, fallback.color),
  alpha: clamp(Number(brush.alpha ?? fallback.alpha) || fallback.alpha, 0.05, 1),
});

const normalizeBrandColors = (colors = {}) => ({
  primary: normalizeHexColor(colors.primary, DEFAULT_BRAND_COLORS.primary),
  secondary: normalizeHexColor(colors.secondary, DEFAULT_BRAND_COLORS.secondary),
  accent: normalizeHexColor(colors.accent, DEFAULT_BRAND_COLORS.accent),
});

const normalizeThemeMode = (theme) =>
  ["light", "dark"].includes(theme) ? theme : DEFAULT_THEME_MODE;
const normalizeButtonSize = (value) =>
  UI_BUTTON_SIZE_OPTIONS.includes(value) ? value : DEFAULT_UI_BUTTON_SIZE;

const cloneConfig = (value) => JSON.parse(JSON.stringify(value));

export {
  DEFAULT_BRAND_COLORS,
  DEFAULT_IMAGE_BRUSH,
  DEFAULT_THEME_MODE,
  DEFAULT_UI_BUTTON_SIZE,
  DEFAULT_VIDEO_BRUSH,
  normalizeBrandColors,
  normalizeButtonSize,
  normalizeBrushConfig,
  normalizeThemeMode,
  UI_BUTTON_SIZE_OPTIONS,
};

export class ConfigManager {
  static defaultConfig = {
    general: {
      backendPort: 8080,
      launchMode: "cuda",
      modelPath: "",
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
      autoCleanTemp: true,
    },
    advanced: {
      imageHistoryLimit: 10,
      imageWarningSize: 50,
      stateSaveLimit: 100,
      maxConcurrentTasks: 3,
      enableDebugMode: false,
      logLevel: "info",
      imageProcessingMethod: "base64",
      imageBrushDefault: { ...DEFAULT_IMAGE_BRUSH },
      videoBrushDefault: { ...DEFAULT_VIDEO_BRUSH },
    },
    ui: {
      theme: DEFAULT_THEME_MODE,
      buttonSize: DEFAULT_UI_BUTTON_SIZE,
      brandColors: { ...DEFAULT_BRAND_COLORS },
      showWelcomeDialog: true,
      confirmBeforeExit: true,
      autoSaveInterval: 30000,
    },
    video: {
      maxFrameCount: 10000,
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
    },
  };

  static validateConfig(config) {
    const errors = [];

    if (
      !config.general?.backendPort ||
      config.general.backendPort < 1024 ||
      config.general.backendPort > 65535
    ) {
      errors.push("后端端口必须在 1024-65535 范围内");
    }

    if (!["cuda", "cpu"].includes(config.general?.launchMode)) {
      errors.push("启动方式必须是 cuda 或 cpu");
    }

    if (
      config.general?.backendProjectPath &&
      typeof config.general.backendProjectPath !== "string"
    ) {
      errors.push("后端项目路径必须是字符串");
    }

    const numFields = [
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

    numFields.forEach((field) => {
      if (typeof field.value !== "number" || field.value < field.min) {
        errors.push(`${field.name}必须大于等于 ${field.min}`);
      }
      if (field.max && field.value > field.max) {
        errors.push(`${field.name}不能超过 ${field.max}`);
      }
    });

    if (
      config.advanced?.imageProcessingMethod &&
      !["base64", "path"].includes(config.advanced.imageProcessingMethod)
    ) {
      errors.push("图片处理方式必须是 base64 或 path");
    }

    if (!["light", "dark"].includes(config.ui?.theme)) {
      errors.push("主题模式必须是 light 或 dark");
    }

    if (!UI_BUTTON_SIZE_OPTIONS.includes(config.ui?.buttonSize)) {
      errors.push("按钮大小必须是 md、sm 或 xs");
    }

    ["primary", "secondary", "accent"].forEach((key) => {
      if (!isValidHexColor(config.ui?.brandColors?.[key])) {
        errors.push(`主题颜色 ${key} 必须是有效的 Hex 颜色`);
      }
    });

    [
      { value: config.advanced?.imageBrushDefault, name: "图片默认笔刷" },
      { value: config.advanced?.videoBrushDefault, name: "视频默认笔刷" },
    ].forEach(({ value, name }) => {
      if (!value || typeof value !== "object") {
        errors.push(`${name}配置缺失`);
        return;
      }

      if (typeof value.size !== "number" || Number.isNaN(value.size) || value.size < 1) {
        errors.push(`${name}的大小必须大于等于 1`);
      }

      if (typeof value.alpha !== "number" || Number.isNaN(value.alpha)) {
        errors.push(`${name}的透明度必须是数字`);
      } else if (value.alpha < 0.05 || value.alpha > 1) {
        errors.push(`${name}的透明度必须在 0.05-1 范围内`);
      }

      if (!isValidHexColor(value.color)) {
        errors.push(`${name}的颜色必须是有效的 Hex 颜色`);
      }
    });

    const video = config.video || {};
    const videoFields = [
      { key: "batchFrameCount", min: 120, max: 5000, name: "视频固定批次帧数" },
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
        errors.push(`${field.name}必须是数字`);
        return;
      }
      if (value < field.min || value > field.max) {
        errors.push(`${field.name}必须在 ${field.min}-${field.max} 范围内`);
      }
    });

    if (
      video.frameExtractionFormat &&
      !["jpg", "jpeg", "png", "webp"].includes(
        String(video.frameExtractionFormat).toLowerCase()
      )
    ) {
      errors.push("视频拆帧格式仅支持 jpg、jpeg、png 或 webp");
    }

    return errors;
  }

  static mergeWithDefault(userConfig) {
    const merged = this.deepMerge(cloneConfig(this.defaultConfig), userConfig || {});

    if (merged?.video && Object.prototype.hasOwnProperty.call(merged.video, "outputPath")) {
      delete merged.video.outputPath;
    }

    merged.ui = {
      ...merged.ui,
      theme: normalizeThemeMode(merged.ui?.theme),
      buttonSize: normalizeButtonSize(merged.ui?.buttonSize),
      brandColors: normalizeBrandColors(merged.ui?.brandColors),
    };

    merged.advanced = {
      ...merged.advanced,
      imageBrushDefault: normalizeBrushConfig(
        merged.advanced?.imageBrushDefault,
        DEFAULT_IMAGE_BRUSH
      ),
      videoBrushDefault: normalizeBrushConfig(
        merged.advanced?.videoBrushDefault,
        DEFAULT_VIDEO_BRUSH
      ),
    };

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
}
