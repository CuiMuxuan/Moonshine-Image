import { defineStore } from "pinia";
import { ref } from "vue";

import { ConfigManager } from "../config/ConfigManager";

export const useConfigStore = defineStore("config", () => {
  const config = ref(ConfigManager.mergeWithDefault({}));

  const loadConfig = async () => {
    if (!window.electron) {
      config.value = ConfigManager.mergeWithDefault({});
      return;
    }

    try {
      const result = await window.electron.ipcRenderer.invoke("get-app-config");
      config.value = ConfigManager.mergeWithDefault(result || {});
    } catch (error) {
      console.error("加载配置失败:", error);
      config.value = ConfigManager.mergeWithDefault({});
    }
  };

  const saveConfig = async (newConfig) => {
    const mergedConfig = ConfigManager.mergeWithDefault(newConfig);
    const errors = ConfigManager.validateConfig(mergedConfig);
    if (errors.length > 0) {
      return { success: false, errors };
    }

    try {
      config.value = mergedConfig;

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

  const persistConfig = async (newConfig) => {
    const mergedConfig = ConfigManager.mergeWithDefault(newConfig);

    if (window.electron?.ipcRenderer?.invoke) {
      try {
        const electronResult = await window.electron.ipcRenderer.invoke(
          "save-app-config",
          JSON.parse(JSON.stringify(mergedConfig))
        );
        if (!electronResult?.success) {
          return {
            success: false,
            error: electronResult?.error || "配置持久化失败",
          };
        }
      } catch (error) {
        return {
          success: false,
          error: error.message || "配置持久化失败",
        };
      }
    }

    return saveConfig(mergedConfig);
  };

  const resetToDefault = () => {
    config.value = ConfigManager.mergeWithDefault({});
  };

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
    persistConfig,
    resetToDefault,
    getConfig,
    validateConfig: ConfigManager.validateConfig,
  };
});
