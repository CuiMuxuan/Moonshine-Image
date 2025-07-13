import { defineStore } from "pinia";
import { ref } from "vue";
import { useConfigStore } from "./config";

export const useAppStateStore = defineStore("appState", () => {
  const configStore = useConfigStore();
  // 应用状态
  const appState = ref({
    activePage: "image",
    isInitialized: true, // 初始化标识
    imageState: {
      workspace: {
        canvasData: null,
        selection: null,
      },
      ui: {
        leftDrawerOpen: false,
        rightDrawerOpen: false,
        currentModel: "lama",
        showMaskTools: true,
        actionScope: { label: "仅当前文件", value: "current" },
        selectAll: false,
        savePath: "",
        folderPath: "",
        maskFolderPath: "",
        ocrLang: "中文",
        autoLayout: true,
        selectedFileName: null,
      },
      fileExplorer: {
        selectedFilesList: [],
        fileMasks: {},
      },
    },
    videoState: {
      workspace: {
        currentFrame: 0,
        timeline: null,
      },
      ui: {
        // 视频页面的UI状态
      },
      fileExplorer: {
        selectedFilesList: [],
        fileMasks: {},
      },
    },
  });
  // 创建可序列化的状态对象
  const createSerializableState = (state) => {
    // 直接返回深拷贝，不需要额外的文件处理逻辑
    return JSON.parse(JSON.stringify(state));
  };

  // 保存状态
  const saveState = async () => {
    if (window.electron) {
      try {
        // 使用序列化函数处理状态
        const serializableState = createSerializableState(appState.value);
        const result = await window.electron.ipcRenderer.invoke(
          "save-app-state",
          serializableState
        );
        if (!result.success) {
          if (result.oversized) {
            // 状态过大，询问用户是否清除
            return { success: false, oversized: true, error: result.error };
          }
          throw new Error(result.error);
        }
        return { success: true };
      } catch (error) {
        console.error("保存状态失败:", error);
        return { success: false, error: error.message };
      }
    }
    return { success: false, error: "非 Electron 环境" };
  };

  // 加载状态
  const loadState = async () => {
    if (window.electron) {
      try {
        const result = await window.electron.ipcRenderer.invoke(
          "load-app-state"
        );

        if (result.success && result.data) {
          appState.value = { ...appState.value, ...result.data };
          return { success: true };
        }

        return { success: true, noData: true };
      } catch (error) {
        console.error("加载状态失败:", error);
        return { success: false, error: error.message };
      }
    }
    return { success: false, error: "非 Electron 环境" };
  };
  // 更新文件蒙版信息
  const updateFileMask = (page, filePath, maskData) => {
    if (page === "image") {
      if (!appState.value.imageState.fileExplorer.fileMasks) {
        appState.value.imageState.fileExplorer.fileMasks = {};
      }
      appState.value.imageState.fileExplorer.fileMasks[filePath] = maskData;
    } else if (page === "video") {
      if (!appState.value.videoState.fileExplorer.fileMasks) {
        appState.value.videoState.fileExplorer.fileMasks = {};
      }
      appState.value.videoState.fileExplorer.fileMasks[filePath] = maskData;
    }
  };

  // 获取文件蒙版信息
  const getFileMask = (page, filePath) => {
    if (page === "image") {
      return appState.value.imageState.fileExplorer.fileMasks?.[filePath];
    } else if (page === "video") {
      return appState.value.videoState.fileExplorer.fileMasks?.[filePath];
    }
    return null;
  };

  // 清除状态
  const clearState = async () => {
    if (window.electron) {
      try {
        const result = await window.electron.ipcRenderer.invoke(
          "clear-app-state"
        );
        return result;
      } catch (error) {
        console.error("清除状态失败:", error);
        return { success: false, error: error.message };
      }
    }
    return { success: false, error: "非 Electron 环境" };
  };

  // 更新页面状态
  const updatePageState = (page, stateData) => {
    if (page === "image") {
      appState.value.imageState = {
        ...appState.value.imageState,
        ...stateData,
      };
    } else if (page === "video") {
      appState.value.videoState = {
        ...appState.value.videoState,
        ...stateData,
      };
    }
  };

  // 切换页面
  const switchPage = async (newPage) => {
    // 保存当前状态
    const saveResult = await saveState();

    if (!saveResult.success && saveResult.oversized) {
      return { success: false, oversized: true, error: saveResult.error };
    }

    appState.value.activePage = newPage;
    return { success: true };
  };
  // 初始化时加载配置
  const initializeStore = async () => {
    await configStore.loadConfig();
    await loadState();
  };

  // 添加设置初始化状态的方法
  const setInitialized = (value) => {
    appState.value.isInitialized = value;
  };

  // 添加重新开始的方法
  const restart = async () => {
    // 重置为默认状态
    appState.value = {
      activePage: "image",
      isInitialized: true, // 重新开始时设为true
      imageState: {
        workspace: {
          canvasData: null,
          selection: null,
        },
        ui: {
          leftDrawerOpen: false,
          rightDrawerOpen: false,
          currentModel: "lama",
          showMaskTools: true,
          actionScope: { label: "仅当前文件", value: "current" },
          selectAll: false,
          savePath: "",
          folderPath: "",
          maskFolderPath: "",
          ocrLang: "中文",
          autoLayout: true,
          selectedFileName: null,
        },
        fileExplorer: {
          selectedFilesList: [],
          fileMasks: {},
        },
      },
      videoState: {
        workspace: {
          currentFrame: 0,
          timeline: null,
        },
        ui: {},
        fileExplorer: {
          selectedFilesList: [],
          fileMasks: {},
        },
      },
    };
    // 清除保存的状态文件
    await clearState();
    return { success: true };
  };
  return {
    appState,
    saveState,
    loadState,
    clearState,
    updatePageState,
    switchPage,
    initializeStore,
    updateFileMask,
    getFileMask,
    setInitialized,
    restart,
  };
});
