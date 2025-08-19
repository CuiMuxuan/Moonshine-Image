import { defineStore } from "pinia";
import { ref } from "vue";
import { useConfigStore } from "./config";

export const useAppStateStore = defineStore("appState", () => {
  const configStore = useConfigStore();

  // 应用状态 - 重构为适应fileManager
  const appState = ref({
    activePage: "image",
    isInitialized: true,
    imageState: {
      // fileManager状态
      fileManager: {
        files: [],
        currentFileId: null,
        selectedFileIds: [],
        processingConfig: {
          imageType: "base64",
          maskType: "base64",
          responseType: "base64",
        },
      },
      // UI状态
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
        showingOriginal: false,
        dontShowMaxHistoryWarning: false,
        dontShowBackendWarning: false,
      },
    },
    videoState: {
      fileManager: {
        files: [],
        currentFileId: null,
        selectedFileIds: [],
      },
      ui: {},
    },
  });

  // 序列化fileManager状态 - 处理不可序列化的对象
  const serializeFileManagerState = (fileManagerState) => {
    const serialized = {
      files: [],
      currentFileId: fileManagerState.currentFileId,
      selectedFileIds: [...fileManagerState.selectedFileIds],
      processingConfig: { ...fileManagerState.processingConfig },
    };

    // 序列化文件数据
    fileManagerState.files.forEach((file) => {
      const serializedFile = {
        id: file.id,
        name: file.name,
        image: {
          type: file.image.type,
          data: file.image.data,
          displayUrl: file.image.displayUrl,
        },
        mask: file.mask ? {
          type: file.mask.type,
          data: file.mask.data,
          displayUrl: file.mask.displayUrl,
        } : null,
        history: file.history.map(h => ({
          type: h.type,
          data: h.data,
          displayUrl: h.displayUrl,
          timestamp: h.timestamp,
        })),
        createdAt: file.createdAt,
        // 不保存originalFile对象，只保存基本信息
        originalFileInfo: {
          name: file.originalFile?.name,
          type: file.originalFile?.type,
          size: file.originalFile?.size,
          lastModified: file.originalFile?.lastModified,
        },
      };
      serialized.files.push(serializedFile);
    });

    return serialized;
  };

  // 反序列化fileManager状态
  const deserializeFileManagerState = (serializedState) => {
    if (!serializedState) return null;

    const deserialized = {
      files: [],
      currentFileId: serializedState.currentFileId,
      selectedFileIds: [...(serializedState.selectedFileIds || [])],
      processingConfig: {
        imageType: "base64",
        maskType: "base64",
        responseType: "base64",
        ...serializedState.processingConfig,
      },
    };

    // 反序列化文件数据
    if (serializedState.files) {
      serializedState.files.forEach((serializedFile) => {
        const file = {
          id: serializedFile.id,
          name: serializedFile.name,
          image: { ...serializedFile.image },
          mask: serializedFile.mask ? { ...serializedFile.mask } : null,
          history: serializedFile.history || [],
          createdAt: serializedFile.createdAt,
          // 创建一个模拟的File对象用于显示
          originalFile: serializedFile.originalFileInfo ? {
            name: serializedFile.originalFileInfo.name,
            type: serializedFile.originalFileInfo.type,
            size: serializedFile.originalFileInfo.size,
            lastModified: serializedFile.originalFileInfo.lastModified,
          } : null,
        };
        deserialized.files.push(file);
      });
    }

    return deserialized;
  };

  // 保存fileManager状态到appState
  const saveFileManagerState = (page, fileManagerStore) => {
    const serializedState = serializeFileManagerState(fileManagerStore.$state);

    if (page === "image") {
      appState.value.imageState.fileManager = serializedState;
    } else if (page === "video") {
      appState.value.videoState.fileManager = serializedState;
    }
  };

  // 从appState恢复fileManager状态
  const restoreFileManagerState = (page) => {
    if (page === "image") {
      return deserializeFileManagerState(appState.value.imageState.fileManager);
    } else if (page === "video") {
      return deserializeFileManagerState(appState.value.videoState.fileManager);
    }
    return null;
  };

  // 保存UI状态
  const saveUIState = (page, uiState) => {
    if (page === "image") {
      appState.value.imageState.ui = { ...appState.value.imageState.ui, ...uiState };
    } else if (page === "video") {
      appState.value.videoState.ui = { ...appState.value.videoState.ui, ...uiState };
    }
  };

  // 恢复UI状态
  const restoreUIState = (page) => {
    if (page === "image") {
      return appState.value.imageState.ui;
    } else if (page === "video") {
      return appState.value.videoState.ui;
    }
    return {};
  };

  // 创建可序列化的状态对象
  const createSerializableState = (state) => {
    return JSON.parse(JSON.stringify(state));
  };

  // 保存状态到磁盘
  const saveState = async () => {
    if (window.electron) {
      try {
        const serializableState = createSerializableState(appState.value);
        const result = await window.electron.ipcRenderer.invoke(
          "save-app-state",
          serializableState
        );
        if (!result.success) {
          if (result.oversized) {
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

  // 从磁盘加载状态
  const loadState = async () => {
    if (window.electron) {
      try {
        const result = await window.electron.ipcRenderer.invoke("load-app-state");

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

  // 清除状态
  const clearState = async () => {
    if (window.electron) {
      try {
        const result = await window.electron.ipcRenderer.invoke("clear-app-state");
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
    const saveResult = await saveState();

    if (!saveResult.success && saveResult.oversized) {
      return { success: false, oversized: true, error: saveResult.error };
    }

    appState.value.activePage = newPage;
    return { success: true };
  };

  // 初始化store
  const initializeStore = async () => {
    await configStore.loadConfig();
    await loadState();
  };

  // 设置初始化状态
  const setInitialized = (value) => {
    appState.value.isInitialized = value;
  };

  // 重新开始
  const restart = async () => {
    appState.value = {
      activePage: "image",
      isInitialized: true,
      imageState: {
        fileManager: {
          files: [],
          currentFileId: null,
          selectedFileIds: [],
          processingConfig: {
            imageType: "base64",
            maskType: "base64",
            responseType: "base64",
          },
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
          showingOriginal: false,
          dontShowMaxHistoryWarning: false,
          dontShowBackendWarning: false,
        },
      },
      videoState: {
        fileManager: {
          files: [],
          currentFileId: null,
          selectedFileIds: [],
        },
        ui: {},
      },
    };
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
    setInitialized,
    restart,
    saveFileManagerState,
    restoreFileManagerState,
    saveUIState,
    restoreUIState,
  };
});
