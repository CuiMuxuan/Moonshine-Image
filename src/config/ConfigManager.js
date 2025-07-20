export class ConfigManager {
  static defaultConfig = {
    general: {
      backendPort: 8080,
      launchMode: "cuda",
      modelPath: "",
      backendProjectPath: '',
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
    },
    ui: {
      theme: "auto",
      showWelcomeDialog: true,
      confirmBeforeExit: true,
      autoSaveInterval: 30000,
    },
    video: {
      // 视频处理配置
      maxFrameCount: 10000,           // 最大帧数限制
      frameExtractionFormat: "png",   // 帧提取格式
      defaultFrameRate: 30,           // 默认帧率
      maxKeyframes: 100,              // 最大关键帧数
      autoNextFrameInterval: 0.1,     // 自动下一帧间隔（秒）
      tempFramesPath: "",             // 临时帧存储路径
      supportedFormats: ["mp4", "mov", "avi", "mkv", "wmv"],
      // 性能优化配置
      maxConcurrentFrameProcessing: 4, // 最大并发帧处理数
      enableFrameSkipping: true,       // 启用帧跳过优化
      memoryOptimization: true,        // 内存优化模式
      // 自动保存配置
      autoSaveInterval: 30,            // 自动保存间隔（秒）
      maxDraftRetention: 7,            // 草稿保留天数
    }
  };

  static validateConfig(config) {
    const errors = [];

    // 验证端口号
    if (
      !config.general?.backendPort ||
      config.general.backendPort < 1024 ||
      config.general.backendPort > 65535
    ) {
      errors.push("端口号必须在 1024-65535 范围内");
    }

    // 验证启动方式
    if (!["cuda", "cpu"].includes(config.general?.launchMode)) {
      errors.push("启动方式必须是 cuda 或 cpu");
    }

    // 验证后端项目路径（如果设置了）
    if (config.general?.backendProjectPath && typeof config.general.backendProjectPath !== 'string') {
      errors.push('后端项目路径必须是字符串')
    }
    // 验证数字字段
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
        name: "状态保存限制大小",
        min: 10,
      },
    ];

    numFields.forEach((field) => {
      if (typeof field.value !== "number" || field.value < field.min) {
        errors.push(`${field.name}必须是大于等于 ${field.min} 的数字`);
      }
      if (field.max && field.value > field.max) {
        errors.push(`${field.name}不能超过 ${field.max}`);
      }
    });

    // 验证图片处理方式
    if (config.advanced?.imageProcessingMethod &&
        !["base64", "path"].includes(config.advanced.imageProcessingMethod)) {
      errors.push("图片处理方式必须是 base64 或 path");
    }
    return errors;
  }

  static mergeWithDefault(userConfig) {
    return this.deepMerge(this.defaultConfig, userConfig || {});
  }

  static deepMerge(target, source) {
    const result = { ...target };

    for (const key in source) {
      if (
        source[key] &&
        typeof source[key] === "object" &&
        !Array.isArray(source[key])
      ) {
        result[key] = this.deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }

    return result;
  }
}
