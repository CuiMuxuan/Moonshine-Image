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
    },
    ui: {
      theme: "auto",
      showWelcomeDialog: true,
      confirmBeforeExit: true,
      autoSaveInterval: 30000,
    },
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
