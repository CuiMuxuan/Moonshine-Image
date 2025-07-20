import { defineStore } from "pinia";
import { useConfigStore } from "./config";
import { v4 as uuidv4 } from "uuid";

export const useFileManagerStore = defineStore("fileManager", {
  state: () => ({
    // 文件列表，每个文件包含ID、image、mask和历史记录
    files: [],
    // 当前选中的文件ID
    currentFileId: null,
    selectedFileIds: [],
    // 全局处理配置
    processingConfig: {
      imageType: "base64", // 'base64' | 'path'
      maskType: "base64", // 'base64' | 'path'
      responseType: "base64", // 'base64' | 'path'
      tempPath: "",
    },
  }),

  getters: {
    currentFile: (state) => {
      return state.files.find((file) => file.id === state.currentFileId);
    },

    getCurrentDisplayImage: (state) => {
      const file = state.files.find((file) => file.id === state.currentFileId);
      if (!file || !file.history.length) return null;

      // 返回历史记录最上层的图片
      const latestHistory = file.history[file.history.length - 1];
      return latestHistory;
    },
    selectedFiles: (state) => {
      return state.files.filter((file) =>
        state.selectedFileIds.includes(file.id)
      );
    },

    hasProcessedImages: (state) => {
      const file = state.files.find((file) => file.id === state.currentFileId);
      return file?.history?.length > 1 || false;
    },
  },

  actions: {
    // 初始化处理配置
    initProcessingConfig() {
      const configStore = useConfigStore();
      const method =
        configStore.config.advanced?.imageProcessingMethod || "base64";
      this.processingConfig = {
        imageType: method,
        maskType: "base64", // mask始终使用base64
        responseType: method,
      };
    },

    // 从状态恢复fileManager
    restoreFromState(savedState) {
      if (!savedState) return;

      this.files = savedState.files || [];
      this.currentFileId = savedState.currentFileId || null;
      this.selectedFileIds = savedState.selectedFileIds || [];
      this.processingConfig = {
        ...this.processingConfig,
        ...savedState.processingConfig,
      };
    },

    // 获取当前状态的快照
    getStateSnapshot() {
      return {
        files: [...this.files],
        currentFileId: this.currentFileId,
        selectedFileIds: [...this.selectedFileIds],
        processingConfig: { ...this.processingConfig },
      };
    },

    // 添加文件并初始化
    async addFile(file) {
      const fileId = uuidv4();
      const configStore = useConfigStore();

      let imageData;

      // 根据处理方式初始化图片数据
      if (
        configStore.config.advanced?.imageProcessingMethod === "path" &&
        window.electron &&
        file.path
      ) {
        // 路径模式：使用文件路径
        imageData = {
          type: "path",
          data: file.path,
          displayUrl: window.electron
            ? `atom://${file.path.replace(/\\/g, "/")}`
            : `file://${file.path}`,
        };
      } else {
        // base64模式：转换为base64
        const base64 = await this.fileToBase64(file);
        imageData = {
          type: "base64",
          data: base64.split(",")[1], // 去掉data:image前缀
          displayUrl: base64, // 用于显示
        };
      }

      const fileData = {
        id: fileId,
        name: file.name,
        type: file.type || "image/jpeg", // 添加 type 属性，确保有默认值
        size: file.size || 0, // 添加 size 属性，确保有默认值
        originalFile: file,
        image: imageData,
        mask: null, // 初始化时没有mask
        history: [imageData], // 历史记录，初始包含原图
        createdAt: new Date().toISOString(),
      };

      this.files.push(fileData);

      // 如果是第一个文件，设为当前文件
      if (this.files.length === 1) {
        this.currentFileId = fileId;
      }

      return fileData;
    },

    // 设置当前文件
    setCurrentFile(fileId) {
      this.currentFileId = fileId;
    },

    // 更新文件的mask
    updateFileMask(fileId, maskData) {
      const file = this.files.find((f) => f.id === fileId);
      if (file) {
        // 处理不同类型的maskData
        let dataUrl;
        if (typeof maskData === "string") {
          dataUrl = maskData;
        } else if (maskData && typeof maskData === "object" && maskData.data) {
          dataUrl = maskData.data;
        } else {
          console.error("Invalid mask data format:", maskData);
          return;
        }

        // 确保dataUrl是有效的base64字符串
        if (!dataUrl || typeof dataUrl !== "string") {
          console.error("Invalid data URL:", dataUrl);
          return;
        }

        // mask始终使用base64格式
        file.mask = {
          type: "base64",
          data: dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl, // 安全地处理split
          displayUrl: dataUrl,
        };
      }
    },

    // 添加处理结果到历史记录
    async addProcessingResult(fileId, resultData) {
      const file = this.files.find((f) => f.id === fileId);
      if (!file) return;
      let historyItem;

      if (
        this.processingConfig.responseType === "path" &&
        typeof resultData === "string" &&
        !resultData.startsWith("data:")
      ) {
        // 路径模式的结果
        const normalizedPath = resultData.replace(/\\/g, '/');
        historyItem = {
          type: "path",
          data: resultData,
          displayUrl: window.electron ? `atom://${normalizedPath}` : `file://${resultData}`,
          timestamp: new Date().toISOString(),
        };
      } else {
        // base64模式的结果
        const base64Data = resultData.startsWith("data:")
          ? resultData
          : `data:image/png;base64,${resultData}`;
        historyItem = {
          type: "base64",
          data: resultData.startsWith("data:")
            ? resultData.split(",")[1]
            : resultData,
          displayUrl: base64Data,
          timestamp: new Date().toISOString(),
        };
      }

      file.history.push(historyItem);

      // 限制历史记录数量
      const configStore = useConfigStore();
      const limit = configStore.config.advanced?.imageHistoryLimit || 10;
      if (file.history.length > limit) {
        file.history = file.history.slice(-limit);
      }
    },

    // 移除文件
    removeFile(fileId) {
      const index = this.files.findIndex((f) => f.id === fileId);
      if (index !== -1) {
        this.files.splice(index, 1);

        // 如果移除的是当前文件，切换到其他文件
        if (this.currentFileId === fileId) {
          this.currentFileId = this.files.length > 0 ? this.files[0].id : null;
        }

        // 从选中列表中移除
        const selectedIndex = this.selectedFileIds.indexOf(fileId);
        if (selectedIndex !== -1) {
          this.selectedFileIds.splice(selectedIndex, 1);
        }
      }
    },

    // 保存文件
    async saveFile(fileId, targetPath) {
      const file = this.files.find((f) => f.id === fileId);
      if (!file) return false;

      const latestImage =
        file.history && file.history.length > 0
          ? file.history[file.history.length - 1]
          : null;
      if (!latestImage) return false;

      if (
        this.processingConfig.responseType === "path" &&
        latestImage.type === "path"
      ) {
        // 路径模式：复制文件到下载目录
        if (window.electron) {
          try {
            await window.electron.ipcRenderer.invoke("copy-file", {
              source: latestImage.data,
              target: targetPath,
            });
            return true;
          } catch (error) {
            console.error("文件复制失败:", error);
            return false;
          }
        }
      } else {
        // base64模式：保存base64数据
        if (window.electron) {
          try {
            const base64Data = latestImage.data;
            const binaryString = atob(base64Data);
            const arrayBuffer = new ArrayBuffer(binaryString.length);
            const uint8Array = new Uint8Array(arrayBuffer);

            for (let i = 0; i < binaryString.length; i++) {
              uint8Array[i] = binaryString.charCodeAt(i);
            }

            await window.electron.ipcRenderer.invoke("save-file", {
              filePath: targetPath,
              blob: arrayBuffer,
            });
            return true;
          } catch (error) {
            console.error("文件保存失败:", error);
            return false;
          }
        }
      }

      return false;
    },

    // 工具方法：文件转base64
    fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result);
        reader.onerror = (error) => reject(error);
      });
    },

    // 清空所有文件
    clearFiles() {
      this.files = [];
      this.currentFileId = null;
      this.selectedFileIds = [];
    },

    // 切换文件选择状态
    toggleFileSelection(fileId) {
      const index = this.selectedFileIds.indexOf(fileId);
      if (index === -1) {
        this.selectedFileIds.push(fileId);
      } else {
        this.selectedFileIds.splice(index, 1);
      }
    },

    // 全选/取消全选
    selectAllFiles(select = true) {
      if (select) {
        this.selectedFileIds = this.files
          .filter((f) => f.originalFile?.type.startsWith("image/"))
          .map((f) => f.id);
      } else {
        this.selectedFileIds = [];
      }
    },

    // 清空选择
    clearSelection() {
      this.selectedFileIds = [];
    },

    // 撤销处理
    undoProcessing(fileId) {
      const file = this.files.find((f) => f.id === fileId);
      if (file && file.history.length > 1) {
        file.history.pop();
        return true;
      }
      return false;
    },

    // 批量应用蒙版
    async applyMaskToFiles(sourceFileId, targetFileIds) {
      const sourceFile = this.files.find((f) => f.id === sourceFileId);
      if (!sourceFile?.mask) return false;

      for (const targetId of targetFileIds) {
        if (targetId !== sourceFileId) {
          this.updateFileMask(targetId, sourceFile.mask.displayUrl);
        }
      }
      return true;
    },
    // 准备批量处理数据
    async prepareBatchInpaintData(filesToProcess) {
      const configStore = useConfigStore();
      const batchItems = [];
      const tempPath = configStore.config.fileManagement?.tempPath || "";
      const imageFolderName =
        configStore.config.fileManagement?.imageFolderName || "images";
      let fullTempPath = "";
      if (tempPath) {
        // 统一使用正斜杠格式进行路径拼接
        if (window.electron) {
          // 在 Electron 环境中，先使用 path.join 然后标准化为正斜杠
          const joinedPath = window.electron.path?.join(tempPath, imageFolderName) ||
            `${tempPath}${window.electron.path?.sep || "/"}${imageFolderName}`;
          // 将所有反斜杠替换为正斜杠，确保路径格式统一
          fullTempPath = joinedPath.replace(/\\/g, '/');
        } else {
          // 在浏览器环境中直接使用正斜杠拼接
          const normalizedTempPath = tempPath.replace(/\\/g, '/');
          fullTempPath = `${normalizedTempPath}/${imageFolderName}`;
        }
      }
      for (let i = 0; i < filesToProcess.length; i++) {
        const file = filesToProcess[i];

        // 获取图像数据
        let imageData;
        const latestImage = file.history[file.history.length - 1];

        if (this.processingConfig.imageType === "base64") {
          if (latestImage.type === "base64") {
            imageData = latestImage.data;
          } else {
            // 转换为base64
            const imageBase64 = await this.fileToBase64(file.originalFile);
            imageData = imageBase64.split(",")[1]; // 提取纯base64
          }
        } else {
          // 使用路径模式
          imageData = file.originalFile.path || file.originalFile.name;
        }

        // 获取蒙版数据
        let maskData;
        if (this.processingConfig.maskType === "base64") {
          maskData = file.mask.data;
        } else {
          // 使用路径模式
          maskData = file.mask.path || `mask_${file.id}.png`;
        }

        batchItems.push({
          id: file.id,
          image: imageData,
          mask: maskData,
        });
      }
      return {
        data: batchItems,
        image_type: this.processingConfig.imageType,
        mask_type: this.processingConfig.maskType,
        response_type: this.processingConfig.responseType,
        temp_path: fullTempPath,
      };
    },
  },

  // 获取选中的文件用于处理（简化的处理逻辑）
  getSelectedFilesForProcessing() {
    return this.selectedFiles.filter(
      (file) => file.mask && file.mask.data // 只返回有蒙版的文件
    );
  },

  // 获取所有可处理的文件
  getAllProcessableFiles() {
    return this.files.filter(
      (file) => file.mask && file.mask.data // 只返回有蒙版的文件
    );
  },
});
