import { defineStore } from "pinia";
import { v4 as uuidv4 } from "uuid";

import { useConfigStore } from "./config";
import { buildImageOutputRequestOptions } from "src/utils/imageOutputOptions";

const DEFAULT_PROCESSING_CONFIG = Object.freeze({
  method: "auto",
  imageType: "path",
  maskType: "base64",
  responseType: "path",
  tempPath: "",
});

const AUTO_BASE64_MAX_FILE_COUNT = 100;
const AUTO_BASE64_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

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

const normalizeImageFormat = (value = "") => {
  const normalized = String(value || "").trim().toLowerCase().replace(/^\./, "");
  if (normalized === "jpeg") return "jpg";
  return ["png", "jpg", "webp", "gif", "bmp"].includes(normalized) ? normalized : "";
};

const normalizeProcessingMethod = (value = "") =>
  ["auto", "path", "base64"].includes(value) ? value : "auto";

const getExtensionFromName = (fileName = "") => {
  const match = String(fileName || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  const format = normalizeImageFormat(match?.[1] || "");
  return format ? `.${format}` : "";
};

const getImageFormatFromMimeType = (mimeType = "") => {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/png") return "png";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  if (normalized === "image/bmp") return "bmp";
  return "";
};

const getExtensionFromMimeType = (mimeType = "") => {
  const format = getImageFormatFromMimeType(mimeType);
  return format ? `.${format}` : "";
};

const getImageMetadataFromFile = (file = {}) => {
  const mimeType = file?.type || resolveMimeTypeFromName(file?.name);
  const extension = getExtensionFromName(file?.name) || getExtensionFromMimeType(mimeType);
  const format = normalizeImageFormat(extension) || getImageFormatFromMimeType(mimeType);
  return {
    format,
    mimeType,
    extension: extension || (format ? `.${format}` : ""),
  };
};

const normalizeRuntimeFileInfo = (file = {}) => ({
  name: file?.name || "",
  type: file?.type || resolveMimeTypeFromName(file?.name),
  size: Number(file?.size || 0),
  lastModified: Number(file?.lastModified || Date.now()),
  path: file?.path || "",
  normalizedPath: file?.normalizedPath || file?.path || "",
});

const getImageMetadataFromResult = (resultData, metadata = {}) => {
  const dataUrlMime = typeof resultData === "string"
    ? resultData.match(/^data:([^;]+);base64,/)?.[1] || ""
    : "";
  const mimeType = metadata.mimeType || metadata.mime_type || dataUrlMime || "";
  const extension = metadata.extension || getExtensionFromMimeType(mimeType);
  const format = normalizeImageFormat(metadata.format || extension) || getImageFormatFromMimeType(mimeType);
  const applyScope = metadata.applyScope || metadata.apply_scope || "";
  const inferenceStrategy = metadata.inferenceStrategy || metadata.inference_strategy || "";
  return {
    format,
    mimeType: mimeType || (format === "jpg" ? "image/jpeg" : format ? `image/${format}` : ""),
    extension: extension || (format ? `.${format}` : ".png"),
    ...(applyScope ? { applyScope } : {}),
    ...(inferenceStrategy ? { inferenceStrategy } : {}),
  };
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

const normalizePathKey = (filePath = "") =>
  String(filePath || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();

const createPathFileData = (descriptor = {}) => {
  const fileId = uuidv4();
  const filePath = descriptor.path || descriptor.normalizedPath || "";
  const normalizedFile = {
    name: descriptor.name || filePath.split(/[\\/]/).pop() || "image",
    type: descriptor.type || resolveMimeTypeFromName(descriptor.name || filePath),
    size: Number(descriptor.size || 0),
    lastModified: Number(descriptor.lastModified || Date.now()),
    path: filePath,
    normalizedPath: descriptor.normalizedPath || filePath,
  };
  const metadata = getImageMetadataFromFile(normalizedFile);
  const imageData = {
    type: "path",
    data: filePath,
    displayUrl: getRendererDisplayUrl(filePath),
    ...metadata,
  };

  return {
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
};

const buildMissingFileMessage = (fileName = "当前文件") =>
  `${fileName} 对应的本地文件已被删除、移动或不可访问，请重新导入后再试`;

const PROCESSING_INPUT_ERROR_MESSAGES = Object.freeze({
  INPUT_PATH_MISSING: "文件不存在或路径已失效",
  INPUT_PATH_INVALID: "图片路径无效",
  INPUT_READ_FAILED: "图片文件无法读取",
});

class ProcessingInputError extends Error {
  constructor(code, fileName, details = "") {
    const reason = PROCESSING_INPUT_ERROR_MESSAGES[code] || "图片输入无效";
    super(`${fileName || "当前文件"}：${reason}${details ? `（${details}）` : ""}`);
    this.name = "ProcessingInputError";
    this.code = code;
    this.userMessage = reason;
  }
}

const buildProcessingInputFailure = (file, index, error) => ({
  id: file?.id,
  index,
  file_name: file?.name || "未知图片",
  success: false,
  error_code: error?.code || "INPUT_READ_FAILED",
  error: error?.userMessage || PROCESSING_INPUT_ERROR_MESSAGES.INPUT_READ_FAILED,
});

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

const estimateBase64Bytes = (base64Data = "") => {
  const raw = String(base64Data || "").split(",").pop() || "";
  if (!raw) return 0;
  const padding = raw.endsWith("==") ? 2 : raw.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((raw.length * 3) / 4) - padding);
};

const sanitizeFileNamePart = (value = "image") => {
  const normalized = String(value || "image")
    .replace(/[<>:"/\\|?*]/g, "_")
    .split("")
    .filter((char) => char.charCodeAt(0) >= 32)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return (normalized || "image").slice(0, 96);
};

const splitNameAndExtension = (fileName = "image", fallbackExtension = ".png") => {
  const extension = getExtensionFromName(fileName) || fallbackExtension || ".png";
  const baseName = extension && fileName.toLowerCase().endsWith(extension)
    ? fileName.slice(0, -extension.length)
    : String(fileName || "image").replace(/\.[^.]+$/, "");
  return {
    baseName: sanitizeFileNamePart(baseName || "image"),
    extension,
  };
};

export const useFileManagerStore = defineStore("fileManager", {
  state: () => ({
    files: [],
    currentFileId: null,
    selectedFileIds: [],
    lastProcessingInputWarnings: [],
    pendingProcessingInputCleanupDirectories: [],
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
      const method = normalizeProcessingMethod(
        configStore.config.advanced?.imageProcessingMethod
      );
      const transport = method === "base64" ? "base64" : "path";

      this.processingConfig = {
        ...DEFAULT_PROCESSING_CONFIG,
        method,
        imageType: transport,
        responseType: transport,
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
        normalizeProcessingMethod(configStore.config.advanced?.imageProcessingMethod);

      let imageData;
      if (preferredMethod !== "base64" && window.electron && file?.path) {
        const metadata = getImageMetadataFromFile(file);
        imageData = {
          type: "path",
          data: file.path,
          displayUrl: getRendererDisplayUrl(file.path),
          ...metadata,
        };
        progressCallback?.(1);
      } else {
        const base64 = await this.fileToBase64(file, progressCallback);
        const metadata = getImageMetadataFromFile(file);
        imageData = {
          type: "base64",
          data: base64.split(",")[1],
          displayUrl: base64,
          ...metadata,
        };
      }

      const normalizedFile = normalizeRuntimeFileInfo(file);

      const fileData = {
        id: fileId,
        name: normalizedFile.name || "image",
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

    addPathFiles(descriptors = []) {
      const existingPathKeys = new Set(
        this.files
          .map((file) => normalizePathKey(file.originalFile?.path || file.image?.data || ""))
          .filter(Boolean)
      );
      const createdFiles = [];

      for (const descriptor of descriptors) {
        const filePath = descriptor?.path || descriptor?.normalizedPath || "";
        const pathKey = normalizePathKey(filePath);
        if (!pathKey || existingPathKeys.has(pathKey)) {
          continue;
        }
        existingPathKeys.add(pathKey);
        createdFiles.push(createPathFileData(descriptor));
      }

      if (createdFiles.length === 0) {
        return [];
      }

      const hadFiles = this.files.length > 0;
      this.files.push(...createdFiles);
      if (!hadFiles) {
        this.currentFileId = createdFiles[0].id;
      }
      return createdFiles;
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

    async addProcessingResult(fileId, resultData, metadata = {}) {
      const file = this.files.find((item) => item.id === fileId);
      if (!file) return;

      let historyItem;
      const resultMetadata = getImageMetadataFromResult(resultData, metadata);
      if (
        this.processingConfig.responseType === "path" &&
        typeof resultData === "string" &&
        !resultData.startsWith("data:")
      ) {
        historyItem = {
          type: "path",
          data: resultData,
          displayUrl: getRendererDisplayUrl(resultData),
          ...resultMetadata,
          timestamp: new Date().toISOString(),
        };
      } else {
        const dataUrl = resultData.startsWith("data:")
          ? resultData
          : `${resultMetadata.mimeType ? `data:${resultMetadata.mimeType}` : "data:image/png"};base64,${resultData}`;
        historyItem = {
          type: "base64",
          data: dataUrl.split(",")[1],
          displayUrl: dataUrl,
          ...getImageMetadataFromResult(dataUrl, resultMetadata),
          timestamp: new Date().toISOString(),
        };
      }

      file.history.push(historyItem);

      const configStore = useConfigStore();
      const limit = Math.max(
        2,
        Math.floor(Number(configStore.config.advanced?.imageHistoryLimit) || 10)
      );
      if (file.history.length > limit) {
        const originalHistoryItem = file.history[0];
        const processedHistory = file.history.slice(1);
        file.history = [
          originalHistoryItem,
          ...processedHistory.slice(-(limit - 1)),
        ];
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

    invertImageSelection() {
      const imageIds = this.files
        .filter((file) => file.originalFile?.type?.startsWith("image/"))
        .map((file) => file.id);
      const selectedSet = new Set(this.selectedFileIds);
      this.selectedFileIds = imageIds.filter((fileId) => !selectedSet.has(fileId));
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

    consumeProcessingInputWarnings() {
      const warnings = [...this.lastProcessingInputWarnings];
      this.lastProcessingInputWarnings = [];
      return warnings;
    },

    consumeProcessingInputCleanupDirectories() {
      const directories = [...new Set(this.pendingProcessingInputCleanupDirectories.filter(Boolean))];
      this.pendingProcessingInputCleanupDirectories = [];
      return directories;
    },

    getImageWarningSizeBytes(config) {
      const warningMb = Math.max(
        1,
        Number(config?.advanced?.imageWarningSize || 50)
      );
      return warningMb * 1024 * 1024;
    },

    getImageInputSizeEstimate(file) {
      const latestImage = Array.isArray(file?.history)
        ? file.history[file.history.length - 1]
        : null;
      if (latestImage?.type === "base64") {
        return estimateBase64Bytes(latestImage.data);
      }
      return Number(file?.originalFile?.size || file?.size || 0);
    },

    resolveProcessingTransport(filesToProcess = [], options = {}) {
      const configStore = useConfigStore();
      const method = normalizeProcessingMethod(
        configStore.config.advanced?.imageProcessingMethod
      );

      if (method === "path" || method === "base64") {
        return method;
      }

      if (options.folderMode) {
        return "path";
      }

      const files = Array.isArray(filesToProcess) ? filesToProcess : [];
      if (
        files.length === 0 ||
        files.length > AUTO_BASE64_MAX_FILE_COUNT
      ) {
        return "path";
      }

      const warningSizeBytes = this.getImageWarningSizeBytes(configStore.config);
      let totalSizeBytes = 0;
      for (const file of files) {
        const sizeBytes = this.getImageInputSizeEstimate(file);
        if (!sizeBytes || sizeBytes > warningSizeBytes) {
          return "path";
        }
        totalSizeBytes += sizeBytes;
        if (totalSizeBytes > AUTO_BASE64_MAX_TOTAL_BYTES) {
          return "path";
        }
      }

      return "base64";
    },

    async getPathFileSizeBytes(filePath) {
      if (!filePath || !window.electron?.ipcRenderer?.invoke) {
        return 0;
      }
      const stats = await window.electron.ipcRenderer.invoke("get-file-stats", filePath);
      if (!stats?.success) {
        return 0;
      }
      return Number(stats.data?.size || 0);
    },

    async assertCanConvertPathToBase64(file, filePath, config) {
      const sizeBytes =
        Number(file?.originalFile?.path === filePath ? file.originalFile?.size : 0) ||
        Number(file?.size || 0) ||
        await this.getPathFileSizeBytes(filePath);
      const warningSizeBytes = this.getImageWarningSizeBytes(config);
      if (sizeBytes > warningSizeBytes) {
        const warningMb = Math.round(warningSizeBytes / 1024 / 1024);
        throw new Error(
          `${file?.name || "当前图片"} 超过 ${warningMb}MB，不能转换为 Base64，请切换为文件路径或自动模式。`
        );
      }
    },

    createProcessingInputContext(config, transport) {
      const tempRoot = config.fileManagement?.tempPath || "";
      const imageFolderName = config.fileManagement?.imageFolderName || "images";
      const imageTempPath =
        tempRoot && window.electron?.ipcRenderer?.joinPath
          ? window.electron.ipcRenderer.joinPath(tempRoot, imageFolderName).replace(/\\/g, "/")
          : "";
      const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const chainInputPath =
        imageTempPath && window.electron?.ipcRenderer?.joinPath
          ? window.electron.ipcRenderer
              .joinPath(imageTempPath, "chain-inputs", runId)
              .replace(/\\/g, "/")
          : "";

      return {
        config,
        transport,
        imageTempPath,
        chainInputPath,
        materializedInputCount: 0,
        warnings: [],
      };
    },

    getOriginalImageSource(file) {
      const originalImage = Array.isArray(file?.history) ? file.history[0] : file?.image;
      return originalImage || file?.image || null;
    },

    getLatestImageInputSource(file) {
      const history = Array.isArray(file?.history) && file.history.length > 0
        ? file.history
        : [file?.image].filter(Boolean);
      const historyIndex = Math.max(0, history.length - 1);
      return {
        historyIndex,
        imageSource: history[historyIndex] || null,
      };
    },

    async materializeBase64ImageToTempPath(file, historyItem, historyIndex, context) {
      if (!window.electron?.ipcRenderer?.invoke || !context.chainInputPath) {
        throw new Error("当前环境无法将内存图片写入临时文件，请切换为 Base64 模式。");
      }

      const outputExtension =
        historyItem?.extension ||
        getExtensionFromMimeType(historyItem?.mimeType || historyItem?.mime_type) ||
        getExtensionFromName(file?.name) ||
        ".png";
      const originalParts = splitNameAndExtension(file?.name || "image", outputExtension);
      const targetName = `${originalParts.baseName}__latest_${String(file?.id || "file").slice(0, 8)}_h${historyIndex}${outputExtension}`;
      const targetPath = window.electron.ipcRenderer
        .joinPath(context.chainInputPath, targetName)
        .replace(/\\/g, "/");
      if (!this.pendingProcessingInputCleanupDirectories.includes(context.chainInputPath)) {
        this.pendingProcessingInputCleanupDirectories.push(context.chainInputPath);
      }
      const savedPath = await window.electron.ipcRenderer.invoke("save-file", {
        filePath: targetPath,
        blob: convertBase64ToArrayBuffer(historyItem.data),
      });

      context.materializedInputCount += 1;

      return typeof savedPath === "string" ? savedPath : targetPath;
    },

    async resolveLatestImageInput(file, targetTransport, context) {
      const { historyIndex, imageSource } = this.getLatestImageInputSource(file);

      if (!imageSource) {
        throw new ProcessingInputError("INPUT_PATH_INVALID", file?.name);
      }

      if (targetTransport === "path") {
        if (imageSource.type === "path") {
          const imagePath = imageSource.data || resolveOriginalFilePath(file);
          if (!imagePath) {
            throw new ProcessingInputError("INPUT_PATH_INVALID", file?.name);
          }
          if (!(await this.fileExists(imagePath))) {
            throw new ProcessingInputError("INPUT_PATH_MISSING", file?.name);
          }
          return imagePath;
        }

        if (imageSource.type === "base64" && imageSource.data) {
          return await this.materializeBase64ImageToTempPath(
            file,
            imageSource,
            historyIndex,
            context
          );
        }
      }

      if (targetTransport === "base64") {
        if (imageSource.type === "base64" && imageSource.data) {
          return imageSource.data;
        }

        const imagePath = imageSource.data || resolveOriginalFilePath(file);
        if (!imagePath) {
          throw new ProcessingInputError("INPUT_PATH_INVALID", file?.name);
        }
        if (!(await this.fileExists(imagePath))) {
          throw new ProcessingInputError("INPUT_PATH_MISSING", file?.name);
        }
        await this.assertCanConvertPathToBase64(file, imagePath, context.config);
        let fileBase64;
        try {
          fileBase64 = await this.fileToBase64({
            name: file.name,
            type: file.type,
            path: imagePath,
          });
        } catch (error) {
          throw new ProcessingInputError(
            "INPUT_READ_FAILED",
            file?.name,
            error?.message || ""
          );
        }
        return fileBase64.split(",")[1];
      }

      throw new Error(`不支持的图片处理方式: ${targetTransport}`);
    },

    async prepareBatchInpaintData(filesToProcess) {
      const configStore = useConfigStore();
      const imageType = this.resolveProcessingTransport(filesToProcess);
      const responseType = imageType;
      const context = this.createProcessingInputContext(configStore.config, imageType);
      this.lastProcessingInputWarnings = [];
      this.processingConfig = {
        ...this.processingConfig,
        method: normalizeProcessingMethod(configStore.config.advanced?.imageProcessingMethod),
        imageType,
        responseType,
        tempPath: context.imageTempPath,
      };

      const batchItems = [];
      const clientFailures = [];
      const sourceIndexes = [];
      for (let index = 0; index < filesToProcess.length; index += 1) {
        const file = filesToProcess[index];

        if (!file.mask?.data) {
          throw new Error(`缺少蒙版数据: ${file.name}`);
        }

        let imageData;
        try {
          imageData = await this.resolveLatestImageInput(file, imageType, context);
        } catch (error) {
          if (!(error instanceof ProcessingInputError)) throw error;
          clientFailures.push(buildProcessingInputFailure(file, index, error));
          continue;
        }

        batchItems.push({
          id: file.id,
          image: imageData,
          mask: file.mask.data,
        });
        sourceIndexes.push(index);
      }
      this.lastProcessingInputWarnings = [...new Set(context.warnings)];

      return {
        data: batchItems,
        image_type: imageType,
        mask_type: "base64",
        response_type: responseType,
        temp_path: responseType === "path" ? context.imageTempPath : "",
        ...buildImageOutputRequestOptions(configStore.config),
        _clientFailures: clientFailures,
        _sourceIndexes: sourceIndexes,
        _requestedCount: filesToProcess.length,
        _cleanupDirectory:
          context.materializedInputCount > 0 ? context.chainInputPath : "",
      };
    },

    async prepareMoonshineImageProcessData(filesToProcess, { includeMasks = false } = {}) {
      const configStore = useConfigStore();
      const imageType = this.resolveProcessingTransport(filesToProcess);
      const responseType = imageType;
      const context = this.createProcessingInputContext(configStore.config, imageType);
      this.lastProcessingInputWarnings = [];
      this.processingConfig = {
        ...this.processingConfig,
        method: normalizeProcessingMethod(configStore.config.advanced?.imageProcessingMethod),
        imageType,
        responseType,
        tempPath: context.imageTempPath,
      };

      const batchItems = [];
      const clientFailures = [];
      const sourceIndexes = [];
      for (let index = 0; index < filesToProcess.length; index += 1) {
        const file = filesToProcess[index];
        let imageData;
        try {
          imageData = await this.resolveLatestImageInput(file, imageType, context);
        } catch (error) {
          if (!(error instanceof ProcessingInputError)) throw error;
          clientFailures.push(buildProcessingInputFailure(file, index, error));
          continue;
        }
        const item = {
          id: file.id,
          image: imageData,
        };
        if (includeMasks && file.mask?.data) {
          item.mask = file.mask.data;
        }
        batchItems.push(item);
        sourceIndexes.push(index);
      }
      this.lastProcessingInputWarnings = [...new Set(context.warnings)];

      return {
        data: batchItems,
        image_type: imageType,
        ...(includeMasks ? { mask_type: "base64" } : {}),
        response_type: responseType,
        temp_path: responseType === "path" ? context.imageTempPath : "",
        ...buildImageOutputRequestOptions(configStore.config),
        _clientFailures: clientFailures,
        _sourceIndexes: sourceIndexes,
        _requestedCount: filesToProcess.length,
        _cleanupDirectory:
          context.materializedInputCount > 0 ? context.chainInputPath : "",
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
