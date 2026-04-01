import { defineStore } from "pinia";
import { v4 as uuidv4 } from "uuid";

import { useConfigStore } from "./config";

const DEFAULT_PROCESSING_CONFIG = Object.freeze({
  imageType: "path",
  maskType: "base64",
  responseType: "path",
  tempPath: "",
});

const getRendererDisplayUrl = (filePath) => {
  if (!filePath) return "";

  const normalizedPath = String(filePath).replace(/\\/g, "/");
  if (window.electron) {
    return `atom://${normalizedPath}`;
  }
  return `file://${normalizedPath}`;
};

const resolveMimeTypeFromName = (fileName = "") => {
  const normalized = String(fileName || "").toLowerCase();
  if (normalized.endsWith(".png")) return "image/png";
  if (normalized.endsWith(".webp")) return "image/webp";
  if (normalized.endsWith(".gif")) return "image/gif";
  if (normalized.endsWith(".bmp")) return "image/bmp";
  return "image/jpeg";
};

const definePathProperty = (file, filePath) => {
  if (!(file instanceof Blob) || !filePath) {
    return file;
  }

  try {
    Object.defineProperty(file, "path", {
      configurable: true,
      enumerable: true,
      writable: false,
      value: filePath,
    });
  } catch {
    // Ignore failures on platforms where File.path is read-only.
  }

  return file;
};

const createRendererFile = (data = {}, fallback = {}) => {
  const bytes = new Uint8Array(Array.isArray(data.buffer) ? data.buffer : []);
  const fileName = data.name || fallback.name || "image";
  const fileType = data.type || fallback.type || resolveMimeTypeFromName(fileName);
  const lastModified = Number(data.lastModified || fallback.lastModified || Date.now());
  const filePath = data.path || fallback.path || "";
  const file = new File([bytes], fileName, {
    type: fileType,
    lastModified,
  });

  return definePathProperty(file, filePath);
};

const buildMissingFileMessage = (fileName = "当前文件") =>
  `${fileName} 对应的本地文件已被删除、移动或不可访问，请重新导入后再试`;

const resolveOriginalFilePath = (file) => {
  const latestPath = file?.history?.[file.history.length - 1]?.type === "path"
    ? file.history[file.history.length - 1].data
    : "";

  return (
    file?.originalFile?.path ||
    file?.image?.path ||
    file?.image?.data ||
    latestPath ||
    ""
  );
};

const convertBase64ToArrayBuffer = (base64Data) => {
  const binaryString = atob(base64Data);
  const arrayBuffer = new ArrayBuffer(binaryString.length);
  const uint8Array = new Uint8Array(arrayBuffer);

  for (let index = 0; index < binaryString.length; index += 1) {
    uint8Array[index] = binaryString.charCodeAt(index);
  }

  return arrayBuffer;
};

export const useFileManagerStore = defineStore("fileManager", {
  state: () => ({
    files: [],
    currentFileId: null,
    selectedFileIds: [],
    processingConfig: {
      ...DEFAULT_PROCESSING_CONFIG,
    },
  }),

  getters: {
    currentFile: (state) => state.files.find((file) => file.id === state.currentFileId) || null,

    getCurrentDisplayImage: (state) => {
      const file = state.files.find((item) => item.id === state.currentFileId);
      if (!file || !file.history.length) return null;
      return file.history[file.history.length - 1];
    },

    selectedFiles: (state) =>
      state.files.filter((file) => state.selectedFileIds.includes(file.id)),

    hasProcessedImages: (state) => {
      const file = state.files.find((item) => item.id === state.currentFileId);
      return file?.history?.length > 1 || false;
    },
  },

  actions: {
    initProcessingConfig() {
      const configStore = useConfigStore();
      const method =
        configStore.config.advanced?.imageProcessingMethod === "base64" ? "base64" : "path";

      this.processingConfig = {
        ...DEFAULT_PROCESSING_CONFIG,
        imageType: method,
        responseType: method,
        tempPath: configStore.config.fileManagement?.tempPath || "",
      };
    },

    restoreFromState(savedState) {
      if (!savedState) return;

      this.files = savedState.files || [];
      this.currentFileId = savedState.currentFileId || null;
      this.selectedFileIds = savedState.selectedFileIds || [];
      this.processingConfig = {
        ...DEFAULT_PROCESSING_CONFIG,
        ...savedState.processingConfig,
      };
    },

    getStateSnapshot() {
      return {
        files: [...this.files],
        currentFileId: this.currentFileId,
        selectedFileIds: [...this.selectedFileIds],
        processingConfig: { ...this.processingConfig },
      };
    },

    async addFile(file, progressCallback = null) {
      const fileId = uuidv4();
      const configStore = useConfigStore();
      const preferredMethod =
        configStore.config.advanced?.imageProcessingMethod === "base64" ? "base64" : "path";

      let imageData;
      if (preferredMethod === "path" && window.electron && file?.path) {
        imageData = {
          type: "path",
          data: file.path,
          displayUrl: getRendererDisplayUrl(file.path),
        };
        progressCallback?.(1);
      } else {
        const base64 = await this.fileToBase64(file, progressCallback);
        imageData = {
          type: "base64",
          data: base64.split(",")[1],
          displayUrl: base64,
        };
      }

      const normalizedFile = {
        ...file,
        type: file?.type || resolveMimeTypeFromName(file?.name),
        size: Number(file?.size || 0),
      };

      const fileData = {
        id: fileId,
        name: normalizedFile.name,
        type: normalizedFile.type,
        size: normalizedFile.size,
        originalFile: normalizedFile,
        image: imageData,
        mask: null,
        history: [imageData],
        createdAt: new Date().toISOString(),
      };

      this.files.push(fileData);
      if (this.files.length === 1) {
        this.currentFileId = fileId;
      }

      return fileData;
    },

    setCurrentFile(fileId) {
      this.currentFileId = fileId;
    },

    updateFileMask(fileId, maskData) {
      const file = this.files.find((item) => item.id === fileId);
      if (!file) return;

      if (maskData == null) {
        file.mask = null;
        return;
      }

      let dataUrl = "";
      if (typeof maskData === "string") {
        dataUrl = maskData;
      } else if (maskData && typeof maskData === "object" && maskData.data) {
        dataUrl = maskData.data;
      }

      if (!dataUrl || typeof dataUrl !== "string") {
        console.error("Invalid mask data:", maskData);
        return;
      }

      file.mask = {
        type: "base64",
        data: dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl,
        displayUrl: dataUrl,
      };
    },

    async addProcessingResult(fileId, resultData) {
      const file = this.files.find((item) => item.id === fileId);
      if (!file) return;

      let historyItem;
      if (
        this.processingConfig.responseType === "path" &&
        typeof resultData === "string" &&
        !resultData.startsWith("data:")
      ) {
        historyItem = {
          type: "path",
          data: resultData,
          displayUrl: getRendererDisplayUrl(resultData),
          timestamp: new Date().toISOString(),
        };
      } else {
        const dataUrl = resultData.startsWith("data:")
          ? resultData
          : `data:image/png;base64,${resultData}`;
        historyItem = {
          type: "base64",
          data: dataUrl.split(",")[1],
          displayUrl: dataUrl,
          timestamp: new Date().toISOString(),
        };
      }

      file.history.push(historyItem);

      const configStore = useConfigStore();
      const limit = configStore.config.advanced?.imageHistoryLimit || 10;
      if (file.history.length > limit) {
        file.history = file.history.slice(-limit);
      }
    },

    removeFile(fileId) {
      const fileIndex = this.files.findIndex((file) => file.id === fileId);
      if (fileIndex === -1) return;

      this.files.splice(fileIndex, 1);

      if (this.currentFileId === fileId) {
        this.currentFileId = this.files.length > 0 ? this.files[0].id : null;
      }

      this.selectedFileIds = this.selectedFileIds.filter((id) => id !== fileId);
    },

    async saveFile(fileId, targetPath) {
      const file = this.files.find((item) => item.id === fileId);
      if (!file || !file.history?.length) {
        return {
          success: false,
          error: "未找到要保存的文件",
        };
      }

      const latestImage = file.history[file.history.length - 1];

      if (latestImage.type === "path" && latestImage.data && window.electron) {
        if (!(await this.fileExists(latestImage.data))) {
          return {
            success: false,
            error: buildMissingFileMessage(file.name),
          };
        }

        try {
          const result = await window.electron.ipcRenderer.invoke("copy-file", {
            source: latestImage.data,
            target: targetPath,
          });
          return {
            success: Boolean(result?.success),
            targetPath: result?.targetPath || targetPath,
            error: result?.error || "",
          };
        } catch (error) {
          console.error("Failed to copy processed image:", error);
          return {
            success: false,
            error: error.message || "复制文件失败",
          };
        }
      }

      if (latestImage.type === "base64" && window.electron) {
        try {
          const savedPath = await window.electron.ipcRenderer.invoke("save-file", {
            filePath: targetPath,
            blob: convertBase64ToArrayBuffer(latestImage.data),
          });
          return {
            success: true,
            targetPath: typeof savedPath === "string" ? savedPath : targetPath,
            error: "",
          };
        } catch (error) {
          console.error("Failed to save processed image:", error);
          return {
            success: false,
            error: error.message || "保存文件失败",
          };
        }
      }

      return {
        success: false,
        error: "当前环境不支持此保存方式",
      };
    },

    legacyBlobToBase64(file, progressCallback = null) {
      return new Promise((resolve, reject) => {
        if (!(file instanceof Blob)) {
          reject(new Error("当前文件不支持转换为 base64"));
          return;
        }

        const reader = new FileReader();
        if (typeof progressCallback === "function") {
          reader.onprogress = (event) => {
            if (event.lengthComputable) {
              progressCallback(event.loaded / event.total);
            }
          };
          progressCallback(0);
        }

        reader.onload = () => {
          progressCallback?.(1);
          resolve(reader.result);
        };
        reader.onerror = (error) => reject(error);
        reader.readAsDataURL(file);
      });
    },

    async fileExists(filePath) {
      if (!filePath) {
        return false;
      }

      if (!window.electron?.ipcRenderer?.invoke) {
        return true;
      }

      try {
        const result = await window.electron.ipcRenderer.invoke("get-file-stats", filePath);
        return Boolean(result?.success);
      } catch (error) {
        console.error("Failed to check file stats:", error);
        return false;
      }
    },

    async loadElectronFile(file, progressCallback = null) {
      const filePath = typeof file === "string" ? file : file?.path;
      if (!filePath) {
        throw new Error("缺少本地文件路径");
      }

      if (!window.electron?.ipcRenderer?.invoke) {
        throw new Error("当前环境不支持读取本地路径文件");
      }

      const ipcRenderer = window.electron.ipcRenderer;
      let disposeProgressListener = null;

      if (typeof progressCallback === "function" && typeof ipcRenderer.on === "function") {
        progressCallback(0);
        disposeProgressListener = ipcRenderer.on("file-read-progress", (event, payload) => {
          if (payload?.filePath !== filePath) {
            return;
          }

          const progress = Math.max(0, Math.min(1, Number(payload.progress || 0) / 100));
          progressCallback(progress);
        });
      }

      try {
        let result = await ipcRenderer.invoke("read-file-with-progress", filePath);
        if (!result?.success || !result.data?.buffer) {
          result = await ipcRenderer.invoke("read-file", filePath);
        }

        if (!result?.success || !result.data?.buffer) {
          throw new Error(result?.error || buildMissingFileMessage(file?.name));
        }

        progressCallback?.(1);
        return createRendererFile(result.data, file);
      } catch (error) {
        throw new Error(error?.message || buildMissingFileMessage(file?.name));
      } finally {
        disposeProgressListener?.();
      }
    },

    blobToBase64(file, progressCallback = null) {
      return new Promise((resolve, reject) => {
        if (!(file instanceof Blob)) {
          reject(new Error("当前文件不支持转换为 base64"));
          return;
        }

        const reader = new FileReader();
        if (typeof progressCallback === "function") {
          reader.onprogress = (event) => {
            if (event.lengthComputable) {
              progressCallback(event.loaded / event.total);
            }
          };
          progressCallback(0);
        }

        reader.onload = () => {
          progressCallback?.(1);
          resolve(reader.result);
        };
        reader.onerror = (error) => reject(error);
        reader.readAsDataURL(file);
      });
    },

    async fileToBase64(file, progressCallback = null) {
      if (file instanceof Blob) {
        return this.blobToBase64(file, progressCallback);
      }

      if (window.electron && file?.path) {
        const rendererFile = await this.loadElectronFile(
          file,
          typeof progressCallback === "function"
            ? (progress) => progressCallback(progress * 0.85)
            : null
        );

        return this.blobToBase64(
          rendererFile,
          typeof progressCallback === "function"
            ? (progress) => progressCallback(0.85 + progress * 0.15)
            : null
        );
      }

      throw new Error("当前文件不支持转换为 base64");
    },

    clearFiles() {
      this.files = [];
      this.currentFileId = null;
      this.selectedFileIds = [];
    },

    toggleFileSelection(fileId) {
      const index = this.selectedFileIds.indexOf(fileId);
      if (index === -1) {
        this.selectedFileIds.push(fileId);
      } else {
        this.selectedFileIds.splice(index, 1);
      }
    },

    selectAllFiles(select = true) {
      if (!select) {
        this.selectedFileIds = [];
        return;
      }

      this.selectedFileIds = this.files
        .filter((file) => file.originalFile?.type?.startsWith("image/"))
        .map((file) => file.id);
    },

    clearSelection() {
      this.selectedFileIds = [];
    },

    undoProcessing(fileId) {
      const file = this.files.find((item) => item.id === fileId);
      if (!file || file.history.length <= 1) {
        return false;
      }

      file.history.pop();
      return true;
    },

    async applyMaskToFiles(sourceFileId, targetFileIds) {
      const sourceFile = this.files.find((file) => file.id === sourceFileId);
      if (!sourceFile?.mask) return false;

      for (const targetId of targetFileIds) {
        if (targetId !== sourceFileId) {
          this.updateFileMask(targetId, sourceFile.mask.displayUrl);
        }
      }

      return true;
    },

    async prepareBatchInpaintData(filesToProcess) {
      const configStore = useConfigStore();
      const imageType = this.processingConfig.imageType === "base64" ? "base64" : "path";
      const responseType = this.processingConfig.responseType === "base64" ? "base64" : "path";
      const tempRoot = configStore.config.fileManagement?.tempPath || "";
      const imageFolderName = configStore.config.fileManagement?.imageFolderName || "images";
      const tempPath =
        tempRoot && window.electron?.ipcRenderer?.joinPath
          ? window.electron.ipcRenderer.joinPath(tempRoot, imageFolderName).replace(/\\/g, "/")
          : "";

      const batchItems = [];
      for (const file of filesToProcess) {
        const latestImage = file.history[file.history.length - 1];

        let imageData = "";
        if (imageType === "path") {
          if (latestImage.type === "path") {
            imageData = latestImage.data;
          } else if (file.history.length <= 1) {
            imageData = resolveOriginalFilePath(file);
          } else {
            throw new Error(
              `当前图像仅保存在内存中，无法按路径模式继续处理，请切换为 base64 模式或重新导入：${file.name}`
            );
          }
          if (!imageData) {
            throw new Error(`无法读取图片路径: ${file.name}`);
          }
          if (!(await this.fileExists(imageData))) {
            throw new Error(buildMissingFileMessage(file.name));
          }
        } else if (latestImage.type === "base64") {
          imageData = latestImage.data;
        } else {
          const fileBase64 = await this.fileToBase64({
            name: file.name,
            type: file.type,
            path: latestImage.data || resolveOriginalFilePath(file),
          });
          imageData = fileBase64.split(",")[1];
        }

        if (!file.mask?.data) {
          throw new Error(`缺少蒙版数据: ${file.name}`);
        }

        batchItems.push({
          id: file.id,
          image: imageData,
          mask: file.mask.data,
        });
      }

      return {
        data: batchItems,
        image_type: imageType,
        mask_type: "base64",
        response_type: responseType,
        temp_path: responseType === "path" ? tempPath : "",
      };
    },

    getSelectedFilesForProcessing() {
      return this.selectedFiles.filter((file) => file.mask?.data);
    },

    getAllProcessableFiles() {
      return this.files.filter((file) => file.mask?.data);
    },
  },
});
