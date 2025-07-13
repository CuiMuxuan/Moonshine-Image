import { defineStore } from "pinia";
import { ref } from "vue";
import { ConfigManager } from "../config/ConfigManager";

export const useConfigStore = defineStore("config", () => {
  // 使用默认配置初始化
  const config = ref(ConfigManager.defaultConfig);

  // 加载配置
  const loadConfig = async () => {
    if (window.electron) {
      try {
        const result = await window.electron.ipcRenderer.invoke(
          "get-app-config"
        );
        if (result) {
          // 合并用户配置和默认配置
          config.value = ConfigManager.mergeWithDefault(result);
        }
      } catch (error) {
        console.error("加载配置失败:", error);
        // 使用默认配置
        config.value = ConfigManager.defaultConfig;
      }
    }
  };

  // 保存配置
  const saveConfig = async (newConfig) => {
    // 验证配置
    const errors = ConfigManager.validateConfig(newConfig);
    if (errors.length > 0) {
      return { success: false, errors };
    }

    try {
      // 直接更新 Pinia store（因为 Electron 配置文件已经在 GlobalSettings 中保存）
      const mergedConfig = ConfigManager.mergeWithDefault(newConfig);
      config.value = mergedConfig;

      // 触发配置更新事件，通知其他组件
      window.dispatchEvent(
        new CustomEvent("config-updated", {
          detail: { config: mergedConfig },
        })
      );

      return { success: true };
    } catch (error) {
      console.error("更新配置失败:", error);
      return { success: false, error: error.message };
    }
  };

  // 重置为默认配置
  const resetToDefault = () => {
    config.value = { ...ConfigManager.defaultConfig };
  };

  // 获取特定配置项
  const getConfig = (path) => {
    const keys = path.split(".");
    let value = config.value;

    for (const key of keys) {
      value = value?.[key];
      if (value === undefined) break;
    }

    return value;
  };

  return {
    config,
    loadConfig,
    saveConfig,
    resetToDefault,
    getConfig,
    validateConfig: ConfigManager.validateConfig,
  };
});
