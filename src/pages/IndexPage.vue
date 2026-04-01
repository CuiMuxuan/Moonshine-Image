<template>
  <q-page class="flex image-page">
    <!-- 页面禁用覆盖层 -->
    <div
      v-if="isPageDisabled"
      class="page-disabled-overlay"
      @click.stop.prevent
      @mousedown.stop.prevent
      @mouseup.stop.prevent
      @keydown.stop.prevent
      @keyup.stop.prevent
    ></div>
    <!-- 主工作区 -->
    <div class="col image-work-area">
      <div ref="imageStageRef" class="col image-stage-shell" :style="previewStageStyle">
        <workspace
          :selected-file="currentFile"
          :checkerboard="true"
          :class="{ 'pointer-events-none': isPageDisabled }"
        >
          <ImageEditor
            v-if="
              currentFile && currentFile.originalFile?.type.startsWith('image/')
            "
            ref="editorRef"
            :selected-file="currentFile.originalFile"
            :show-masker="showMaskTools"
            :drawing-mode="isMaskDrawingMode"
            :tool-state="imageMaskToolState"
            :mask="currentFile.mask"
            :image-url="currentDisplayUrl"
            :visible-area-insets="visibleAreaInsets"
            @loaded="handleImageLoaded"
            @update:mask="handleMaskUpdate"
            @update:drawing-mode="setMaskDrawingMode"
            @update:tool-state="updateImageMaskToolState"
          />
        </workspace>
      </div>

      <!-- 底部工具栏 -->
    </div>
  </q-page>
</template>

<script setup>
import {
  ref,
  computed,
  watch,
  provide,
  onMounted,
  onUnmounted,
  watchEffect,
  inject,
  nextTick
} from "vue";
import { useQuasar } from "quasar";
import { useConfigStore } from "src/stores/config";
import { useAppStateStore } from "src/stores/appState";
import { useFileManagerStore } from "src/stores/fileManager";
import { useRuntimeUiStore } from "src/stores/runtimeUi";
import { useConfiguredShortcuts } from "src/composables/useConfiguredShortcuts";
import InpaintService from "src/services/ImageProcessingService";
import { buildImageOutputBaseName, splitFileName } from "src/utils/fileNaming";
import { MASK_TOOL_MODES } from "src/utils/maskTool";
import ImageEditor from "../components/image/ImageEditor.vue";
import FileExplorer from "../components/common/FileExplorer.vue";
import Workspace from "../components/common/Workspace.vue";
import ProcessingToolbar from "../components/image/ImageProcessingToolbar.vue";
import ImageSettingsDrawer from "../components/image/ImageSettingsDrawer.vue";
import { onBeforeRouteLeave } from "vue-router";

const $q = useQuasar();
const configStore = useConfigStore();
const appStateStore = useAppStateStore();
const fileManagerStore = useFileManagerStore();
const runtimeUiStore = useRuntimeUiStore();

const getDefaultDrawerState = () => {
  const viewportWidth =
    window.innerWidth || document.documentElement?.clientWidth || $q.screen.width || 0;

  if (viewportWidth >= 1680) {
    return {
      left: true,
      right: true,
    };
  }

  if (viewportWidth >= 1280) {
    return {
      left: true,
      right: false,
    };
  }

  return {
    left: false,
    right: false,
  };
};

const defaultDrawerState = getDefaultDrawerState();
const leftDrawerOpen = ref(defaultDrawerState.left);
const rightDrawerOpen = ref(defaultDrawerState.right);
const currentModel = ref("lama");
const showMaskTools = ref(true);
const isMaskDrawingMode = ref(runtimeUiStore.imageMaskDrawingEnabled);
const imageMaskToolState = computed(() => runtimeUiStore.imageMaskToolState);
const actionScope = ref({ label: "仅当前文件", value: "current" });
const selectAll = ref(false);
const exportPath = ref("");
const imageFolderName = ref("");
const savePath = ref("");
const savePathSourceMode = ref("managed");
const folderPath = ref("");
const maskFolderPath = ref("");
const ocrLang = ref("中文");
const autoLayout = ref(true);
const editorRef = ref(null);
const isImageLoaded = ref(false);
const showingOriginal = ref(false);
const cudaAvailable = ref(false);
const cudaInfo = ref({});
const dontShowMaxHistoryWarning = ref(false);
const dontShowBackendWarning = ref(false);
const isElectron = ref(false);
const resourcesPath = ref("");
const imageStageRef = ref(null);
const visibleAreaInsets = ref({
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
});
let visibleAreaUpdateFrame = 0;
let visibleAreaTransitionFrame = 0;
let visibleAreaResizeObserver = null;
const LEFT_IMAGE_DRAWER_SELECTOR = ".image-page-left-layout-drawer";
const RIGHT_IMAGE_DRAWER_SELECTOR = ".image-page-right-layout-drawer";

const joinRendererPath = (...parts) => {
  const normalizedParts = parts.filter((part) => typeof part === "string" && part.length > 0);
  if (normalizedParts.length === 0) return "";
  if (window.electron?.ipcRenderer?.joinPath) {
    return window.electron.ipcRenderer.joinPath(...normalizedParts);
  }
  return normalizedParts.join("/").replace(/\/+/g, "/");
};

const getManagedImageOutputPath = (downloadPath, folderName) => {
  if (!downloadPath) return "";
  return joinRendererPath(downloadPath, folderName || "images");
};

const normalizeComparablePath = (value = "") =>
  String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();

const resolveManagedSavePathMode = ({
  candidatePath = "",
  downloadPath = "",
  folderName = "images",
} = {}) => {
  const normalizedCandidate = normalizeComparablePath(candidatePath);
  const normalizedDownloadPath = normalizeComparablePath(downloadPath);
  const normalizedManagedPath = normalizeComparablePath(
    getManagedImageOutputPath(downloadPath, folderName)
  );

  if (!normalizedCandidate) {
    return "managed";
  }

  if (
    normalizedCandidate === normalizedDownloadPath ||
    normalizedCandidate === normalizedManagedPath
  ) {
    return "managed";
  }

  return "custom";
};

const resolveEffectiveImageSavePath = ({
  candidatePath = "",
  downloadPath = "",
  folderName = "images",
  sourceMode = "managed",
} = {}) => {
  const managedPath = getManagedImageOutputPath(downloadPath, folderName);
  if (sourceMode === "managed") {
    return managedPath;
  }

  return candidatePath || managedPath;
};

const syncManagedImageOutputPath = (fileManagement = {}) => {
  const nextImageFolderName = fileManagement.imageFolderName || "images";
  const nextDownloadPath = fileManagement.downloadPath || "";
  const nextSavePathMode =
    savePathSourceMode.value === "managed"
      ? "managed"
      : resolveManagedSavePathMode({
          candidatePath: savePath.value,
          downloadPath: nextDownloadPath,
          folderName: nextImageFolderName,
        });

  const nextSavePath = resolveEffectiveImageSavePath({
    candidatePath: savePath.value,
    downloadPath: nextDownloadPath,
    folderName: nextImageFolderName,
    sourceMode: nextSavePathMode,
  });

  imageFolderName.value = nextImageFolderName;
  exportPath.value = nextDownloadPath;
  savePathSourceMode.value = nextSavePathMode;
  savePath.value = nextSavePath;
};
const props = defineProps({
  backendRunning: {
    type: Boolean,
    default: false,
  },
});
const backendRunning = computed(() => props.backendRunning);
const loadingControl = inject("loadingControl");
const layoutFooter = inject("layoutFooter", null);
const layoutDrawers = inject("layoutDrawers", null);
const isPageDisabled = ref(false);
const imagePageFooterOwner = Symbol("image-page-footer");
const imagePageLeftDrawerOwner = Symbol("image-page-left-drawer");
const imagePageRightDrawerOwner = Symbol("image-page-right-drawer");
const currentFile = computed(() => fileManagerStore.currentFile);
const selectedFiles = computed(() => fileManagerStore.selectedFiles);
const currentDisplayUrl = computed(() => {
  const file = fileManagerStore.currentFile;
  if (!file || !file.history?.length) {
    return null;
  }

  if (showingOriginal.value) {
    return file.history[0]?.displayUrl || null;
  }

  const displayImage = fileManagerStore.getCurrentDisplayImage;
  return displayImage?.displayUrl || null;
});
const currentMask = computed(() => {
  return currentFile.value?.mask || null;
});
const hasProcessedImages = computed(() => {
  return currentFile.value?.history?.length > 1 || false;
});
const previewStageStyle = computed(() => ({
  "--preview-grid-cell-a": "#161616",
  "--preview-grid-cell-b": "#202020",
}));
const isImageMaskerReady = computed(
  () =>
    Boolean(
      currentFile.value &&
        showMaskTools.value &&
        editorRef.value?.isMaskerReady?.()
    )
);
const canUndoMaskShortcut = computed(
  () => Boolean(isImageMaskerReady.value && editorRef.value?.canUndoMask?.())
);
const canUseImageToolbarShortcuts = computed(
  () => Boolean(currentFile.value && currentDisplayUrl.value && !isPageDisabled.value)
);
const canUndoProcessingShortcut = computed(
  () =>
    Boolean(
      canUseImageToolbarShortcuts.value &&
        currentFile.value?.history?.length > 1
    )
);
const canCompareOriginalShortcut = computed(() => canUndoProcessingShortcut.value);
const canSelectAllShortcut = computed(
  () =>
    Boolean(
      canUseImageToolbarShortcuts.value &&
        fileManagerStore.files.some((file) =>
          file.originalFile?.type?.startsWith("image/")
        )
    )
);
const effectiveSavePath = computed(() =>
  resolveEffectiveImageSavePath({
    candidatePath: savePath.value,
    downloadPath: exportPath.value,
    folderName: imageFolderName.value,
    sourceMode: savePathSourceMode.value,
  })
);
const canOpenSavePath = computed(() => Boolean(effectiveSavePath.value && window.electron));

// 提供编辑器引用
provide("editor-ref", editorRef);
provide("image-editor", editorRef);

const fileUrls = computed(() => {
  const urls = {};
  fileManagerStore.files.forEach((file) => {
    const latestImage = file.history[file.history.length - 1];
    urls[file.id] = latestImage?.displayUrl || null;
  });
  return urls;
});

// 切换文件选择
const toggleFileSelection = (file) => {
  fileManagerStore.toggleFileSelection(file.id);
};

const handleModelChange = (model) => {
  currentModel.value = model;
  $q.notify({
    type: "info",
    message: `已切换到${model}模型`,
    position: "top",
  });
};

// 处理全选
const handleSelectAll = (val) => {
  fileManagerStore.selectAllFiles(val);
};

const handleImageLoaded = () => {
  isImageLoaded.value = true;
  nextTick(() => {
    updateVisibleAreaInsets();
  });
};
const handleMaskUpdate = (maskData) => {
  if (fileManagerStore.currentFile) {
    fileManagerStore.updateFileMask(fileManagerStore.currentFile.id, maskData);
  }
};

const setMaskDrawingMode = (value) => {
  const nextValue = Boolean(value);
  isMaskDrawingMode.value = nextValue;
  runtimeUiStore.setImageMaskDrawingEnabled(nextValue);
};

const updateImageMaskToolState = (value = {}) => {
  runtimeUiStore.setImageMaskToolState(
    value,
    configStore.config.advanced?.imageBrushDefault
  );
};

const getImageBrushDefaults = () => configStore.config.advanced?.imageBrushDefault;

const setImageToolMode = (mode) => {
  if (!isImageMaskerReady.value) {
    return false;
  }

  runtimeUiStore.patchImageMaskToolState(
    {
      mode,
    },
    getImageBrushDefaults()
  );

  return true;
};

const restoreImageShortcutSession = (session = {}) => {
  if (!isImageMaskerReady.value) {
    return;
  }

  setMaskDrawingMode(session.imageDrawingEnabled ?? isMaskDrawingMode.value);

  if (session.imageToolMode) {
    runtimeUiStore.patchImageMaskToolState(
      {
        mode: session.imageToolMode,
      },
      getImageBrushDefaults()
    );
  }
};

const handleImageShortcutPress = (actionId) => {
  switch (actionId) {
    case "drawingUndo":
      if (canUndoMaskShortcut.value) {
        editorRef.value?.undoMask?.();
      }
      break;
    case "drawingResetView":
      if (isImageMaskerReady.value) {
        editorRef.value?.resetView?.();
      }
      break;
    case "drawingToggle":
      if (isImageMaskerReady.value) {
        setMaskDrawingMode(!isMaskDrawingMode.value);
      }
      break;
    case "drawingBrush":
      setImageToolMode(MASK_TOOL_MODES.DRAW);
      break;
    case "drawingRect":
      setImageToolMode(MASK_TOOL_MODES.RECT);
      break;
    case "drawingErase":
      setImageToolMode(MASK_TOOL_MODES.ERASE);
      break;
    case "imageUndoProcessing":
      if (canUndoProcessingShortcut.value) {
        undoProcessing();
      }
      break;
    case "imageSelectAll":
      if (canSelectAllShortcut.value) {
        selectAll.value = true;
        handleSelectAll(true);
      }
      break;
    default:
      break;
  }
};

const handleImageShortcutHoldStart = (actionId) => {
  switch (actionId) {
    case "drawingHoldBrush":
      if (isImageMaskerReady.value) {
        setMaskDrawingMode(true);
        setImageToolMode(MASK_TOOL_MODES.DRAW);
      }
      break;
    case "drawingHoldRect":
      if (isImageMaskerReady.value) {
        setMaskDrawingMode(true);
        setImageToolMode(MASK_TOOL_MODES.RECT);
      }
      break;
    case "drawingHoldErase":
      if (isImageMaskerReady.value) {
        setMaskDrawingMode(true);
        setImageToolMode(MASK_TOOL_MODES.ERASE);
      }
      break;
    case "imageCompareOriginal":
      if (canCompareOriginalShortcut.value) {
        showOriginalImage();
      }
      break;
    default:
      break;
  }
};

const handleImageShortcutHoldEnd = (actionId, session) => {
  switch (actionId) {
    case "drawingHoldBrush":
    case "drawingHoldRect":
    case "drawingHoldErase":
      restoreImageShortcutSession(session);
      break;
    case "imageCompareOriginal":
      showProcessedImage();
      break;
    default:
      break;
  }
};

const buildProcessedImageOutputName = (file) => {
  const { extension } = splitFileName(file?.name || "");
  const outputExtension = extension || ".png";
  const namingMode = configStore.config.advanced?.imageOutputNamingMode || "original";
  const fixedPrefix = configStore.config.advanced?.imageOutputFixedPrefix || "moonshine";
  const baseName = buildImageOutputBaseName({
    originalName: file?.name || "",
    namingMode,
    fixedPrefix,
  });

  return `${baseName}${outputExtension}`;
};

const getFileNameFromPath = (filePath, fallback = "") =>
  String(filePath || fallback)
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || fallback;

useConfiguredShortcuts({
  enabled: computed(() => true),
  shortcutConfig: computed(() => configStore.config.shortcuts),
  createSessionContext: () => ({
    imageToolMode: imageMaskToolState.value.mode,
    imageDrawingEnabled: isMaskDrawingMode.value,
  }),
  onPress: (actionId) => {
    handleImageShortcutPress(actionId);
  },
  onHoldStart: (actionId) => {
    handleImageShortcutHoldStart(actionId);
  },
  onHoldEnd: (actionId, session) => {
    handleImageShortcutHoldEnd(actionId, session);
  },
});

const captureMaskUiState = () => ({
  showMaskTools: showMaskTools.value,
  drawingMode: isMaskDrawingMode.value,
});

const restoreMaskUiState = (maskUiState = {}) => {
  showMaskTools.value = maskUiState.showMaskTools ?? showMaskTools.value;
  setMaskDrawingMode(maskUiState.drawingMode ?? isMaskDrawingMode.value);
};

const finalizeSuccessfulMaskRun = async (
  maskUiState,
  { processedFileIds = [], forceClearCurrentMask = false } = {}
) => {
  const currentId = fileManagerStore.currentFile?.id;
  const shouldClearCurrentMask =
    Boolean(currentId) && (forceClearCurrentMask || processedFileIds.includes(currentId));

  if (shouldClearCurrentMask) {
    fileManagerStore.updateFileMask(currentId, null);
  }

  await nextTick();
  restoreMaskUiState(maskUiState);
};

// 确认删除选中文件时同时删除对应的蒙版
const confirmDeleteSelected = () => {
  if (fileManagerStore.selectedFiles.length === 0) return;

  $q.dialog({
    title: "确认删除",
    message: `确定要删除选中的 ${fileManagerStore.selectedFiles.length} 个文件吗？`,
    cancel: {
      label: "取消",
      color: "info",
    },
    ok: {
      color: "negative",
      label: "确认删除",
    },
    persistent: true,
  }).onOk(() => {
    // 删除选中的文件
    const selectedIds = [...fileManagerStore.selectedFileIds];
    selectedIds.forEach((fileId) => {
      fileManagerStore.removeFile(fileId);
    });
  });
};

// 选中文件适应当前蒙版
const applyCurrentMaskToSelected = async () => {
  const currentMaskData = fileManagerStore.currentFile?.mask;
  if (!currentMaskData || !currentMaskData.displayUrl) {
    return;
  }

  // 应用到所有选中文件
  for (const file of fileManagerStore.selectedFiles) {
    if (file.id !== fileManagerStore.currentFile.id) {
      try {
        // 获取目标图片的尺寸并调整蒙版
        const resizedMaskData = await resizeMaskForFile(
          file,
          currentMaskData.displayUrl
        );
        fileManagerStore.updateFileMask(file.id, resizedMaskData);
      } catch (error) {
        console.error(`调整蒙版失败: ${file.name}`, error);
      }
    }
  }
};

// 为指定文件调整蒙版大小
const resizeMaskForFile = async (targetFile, sourceMaskUrl) => {
  try {
    // 获取目标图片的尺寸
    const targetDimensions = await getImageDimensions(targetFile);

    // 获取源蒙版的尺寸
    const sourceDimensions = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = () => reject(new Error("无法加载蒙版图像"));
      img.src = sourceMaskUrl;
    });

    // 调整蒙版大小
    const resizedMask = await resizeMaskData(
      sourceMaskUrl,
      sourceDimensions.width,
      sourceDimensions.height,
      targetDimensions.width,
      targetDimensions.height
    );

    return resizedMask;
  } catch (error) {
    console.error("调整蒙版大小失败:", error);
    throw error;
  }
};

const normalizeRendererImagePath = (filePath = "") => {
  const normalizedPath = String(filePath).replace(/\\/g, "/");
  return window.electron ? `atom://${normalizedPath}` : `file://${normalizedPath}`;
};

const createImageLoadSource = async (fileEntry) => {
  const latestImage =
    Array.isArray(fileEntry?.history) && fileEntry.history.length > 0
      ? fileEntry.history[fileEntry.history.length - 1]
      : null;

  if (latestImage?.type === "base64" && latestImage.displayUrl) {
    return {
      src: latestImage.displayUrl,
      revoke: () => {},
    };
  }

  if (latestImage?.type === "path" && latestImage.data) {
    if (window.electron && !(await fileManagerStore.fileExists(latestImage.data))) {
      throw new Error(`图片文件不存在: ${fileEntry?.name || latestImage.data}`);
    }

    return {
      src: normalizeRendererImagePath(latestImage.data),
      revoke: () => {},
    };
  }

  if (fileEntry?.originalFile instanceof Blob) {
    const objectUrl = URL.createObjectURL(fileEntry.originalFile);
    return {
      src: objectUrl,
      revoke: () => URL.revokeObjectURL(objectUrl),
    };
  }

  if (fileEntry instanceof Blob) {
    const objectUrl = URL.createObjectURL(fileEntry);
    return {
      src: objectUrl,
      revoke: () => URL.revokeObjectURL(objectUrl),
    };
  }

  if (fileEntry?.originalFile?.path) {
    if (window.electron && !(await fileManagerStore.fileExists(fileEntry.originalFile.path))) {
      throw new Error(`图片文件不存在: ${fileEntry?.name || fileEntry.originalFile.path}`);
    }

    return {
      src: normalizeRendererImagePath(fileEntry.originalFile.path),
      revoke: () => {},
    };
  }

  throw new Error(`无法加载图片: ${fileEntry?.name || "unknown"}`);
};

// 获取图片尺寸的辅助函数
const getImageDimensions = async (fileEntry) => {
  const { src, revoke } = await createImageLoadSource(fileEntry);

  return new Promise((resolve, reject) => {
    const img = new Image();
    const cleanup = () => {
      revoke?.();
    };

    img.onload = () => {
      cleanup();
      resolve({
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
    };
    img.onerror = () => {
      cleanup();
      reject(new Error("无法加载图片"));
    };
    img.src = src;
  });
};

// 调整蒙版大小的函数
const resizeMaskData = (
  sourceData,
  sourceWidth,
  sourceHeight,
  targetWidth,
  targetHeight
) => {
  return new Promise((resolve, reject) => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext("2d");

      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, targetWidth, targetHeight);
        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
        resolve(canvas.toDataURL());
      };
      img.onerror = () => reject(new Error("无法加载蒙版图像"));
      img.src = sourceData;
    } catch (error) {
      reject(error);
    }
  });
};

// 运行当前模型
const runCurrentModel = async () => {
  if (!currentFile.value) return;
  // 检查后端服务状态
  if (!backendRunning.value && !dontShowBackendWarning.value) {
    const userChoice = await showBackendWarningDialog();
    if (userChoice === "return") {
      return; // 用户选择返回，不执行后续操作
    }
    // 用户选择继续，继续执行后续操作
  }

  switch (currentModel.value) {
    case "lama":
      runRemoveModel();
      break;
    case "ocr":
      startOcr();
      break;
    case "repair":
      startRepair();
      break;
    default:
      $q.notify({
        type: "info",
        message: "未知模型类型",
        position: "top",
      });
  }
};
// 显示后端服务警告对话框
const showBackendWarningDialog = () => {
  return new Promise((resolve) => {
    $q.dialog({
      title: "后端服务检查",
      message:
        "未检测到Moonshine-Image具有后端服务子进程，请检查后端服务是否已开启，并选择继续运行本次任务处理或返回开启后端？",
      persistent: true,
      ok: {
        label: "继续",
        color: "primary",
        push: true,
      },
      cancel: {
        label: "返回",
        color: "negative",
        push: true,
      },
      options: {
        type: "checkbox",
        model: [],
        items: [
          {
            label: "不再提醒",
            value: "dont_show",
            color: "primary",
          },
        ],
      },
    })
      .onOk((data) => {
        // 检查是否勾选了不再提醒
        if (data && data.includes("dont_show")) {
          dontShowBackendWarning.value = true;
        }
        resolve("continue"); // 用户选择继续
      })
      .onCancel((data) => {
        // 检查是否勾选了不再提醒
        if (data && data.includes("dont_show")) {
          dontShowBackendWarning.value = true;
        }
        resolve("return"); // 用户选择返回
      });
  });
};

// OCR处理函数
const startOcr = () => {
  $q.notify({
    type: "info",
    message: `OCR功能将在作者B站粉丝超过2000时开发`,
    position: "top",
  });
};

// 修复处理函数
const startRepair = () => {
  $q.notify({
    type: "info",
    message: "修复功能将在作者B站粉丝超过3000时开发",
    position: "top",
  });
};
// 运行去除模型
const runRemoveModel = async () => {
  const maskUiState = captureMaskUiState();
  // 确定要处理的文件列表
  let filesToProcess = [];

  if (actionScope.value.value === "folder") {
    // 检查文件夹路径和保存路径是否存在
    if (!folderPath.value) {
      $q.notify({
        type: "negative",
        message: "请先选择输入文件夹路径",
        position: "top",
      });
      return;
    }

    if (!effectiveSavePath.value) {
      $q.notify({
        type: "negative",
        message: "请先选择保存路径",
        position: "top",
      });
      return;
    }

    if (!maskFolderPath.value) {
      $q.notify({
        type: "negative",
        message: "请先选择蒙版文件夹路径",
        position: "top",
      });
      return;
    }

    if (!fileManagerStore.currentFile?.mask?.data) {
      $q.notify({
        type: "negative",
        message: "请先创建一个蒙版作为模板",
        position: "top",
      });
      return;
    }

    // 保存当前蒙版到蒙版文件夹
    try {
      await saveMaskToFolder();
      // 处理文件夹中的图片
      processFolderImages();
    } catch (error) {
      $q.notify({
        type: "negative",
        message: `保存蒙版失败: ${error.message}`,
        position: "top",
      });
    }
    return;
  } else if (
    actionScope.value.value === "selected" &&
    fileManagerStore.selectedFiles.length > 0
  ) {
    // 处理所有选中的文件
    filesToProcess = fileManagerStore.selectedFiles.filter(
      (file) => file.originalFile?.type.startsWith("image/") && file.mask?.data
    );
  } else {
    // 只处理当前选中的文件
    if (
      fileManagerStore.currentFile &&
      fileManagerStore.currentFile.mask?.data
    ) {
      filesToProcess = [fileManagerStore.currentFile];
    }
  }

  if (filesToProcess.length === 0) {
    $q.notify({
      type: "negative",
      message: "请先选择文件并创建蒙版",
      position: "top",
    });
    return;
  }

  // 检查每个文件的历史记录限制
  for (const file of filesToProcess) {
    const proceed = await checkHistoryLimit(file.id);
    if (!proceed) return;
  }

  try {
    if (backendRunning.value) {
      loadingControl.show(
        `正在处理 ${filesToProcess.length} 张图像，你可以打开终端管理页面查看进度`
      );
    } else {
      loadingControl.show(
        `正在处理 ${filesToProcess.length} 张图像，请稍候...`
      );
    }
    isPageDisabled.value = true;

    // 准备批量处理数据
    const requestData = await fileManagerStore.prepareBatchInpaintData(
      filesToProcess
    );

    // 调用API
    const response = await InpaintService.performBatchInpainting(requestData);
    // 处理返回的结果
    const successfulResults = (response.results || []).filter((result) => result?.success);
    if (successfulResults.length > 0) {
      await finalizeSuccessfulMaskRun(maskUiState, {
        processedFileIds: successfulResults
          .map((result) => result.id)
          .filter((id) => typeof id === "string" && id.length > 0),
      });
      // 显示成功通知
      $q.notify({
        type: "positive",
        message: `成功处理了 ${
          successfulResults.length
        } 张图像，总共 ${response.processed_count} 张`,
        position: "top",
      });
    } else {
      throw new Error(response.results?.[0]?.error || "处理结果为空");
    }
  } catch (error) {
    // 显示错误通知
    $q.notify({
      type: "negative",
      message: `图像处理失败: ${error.message}`,
      position: "top",
    });
    console.error("图像处理失败:", error);
  } finally {
    restoreMaskUiState(maskUiState);
    loadingControl.hide();
    isPageDisabled.value = false;
  }
};

const processFolderImages = async () => {
  const maskUiState = captureMaskUiState();
  try {
    // 显示加载状态
    if (backendRunning.value) {
      loadingControl.show(
        "正在批量处理文件夹图像，你可以打开终端管理页面查看进度"
      );
    } else {
      loadingControl.show("正在批量处理文件夹图像，请稍候...");
    }
    isPageDisabled.value = true;

    // 实现文件夹处理逻辑
    const folderData = {
      device: cudaAvailable.value ? "cuda" : "cpu",
      image_folder: folderPath.value,
      mask_folder: maskFolderPath.value,
      output_folder: effectiveSavePath.value,
    };
    // 调用文件夹处理API
    const response = await InpaintService.performFolderInpainting(folderData);
    // 处理返回结果
    if (response.success) {
      await finalizeSuccessfulMaskRun(maskUiState, { forceClearCurrentMask: true });
      const result = response;
      $q.notify({
        type: "positive",
        message: `文件夹处理完成！共处理 ${
          result.processed_count
        } 张图像，耗时 ${result.total_time.toFixed(2)} 秒，请查看输出文件夹`,
        position: "top",
        timeout: 5000,
      });
    } else {
      throw new Error(response.message || "处理失败");
    }
  } catch (error) {
    $q.notify({
      type: "negative",
      message: `处理文件夹失败: ${error.message}`,
      position: "top",
    });
    console.error("处理文件夹失败:", error);
  } finally {
    restoreMaskUiState(maskUiState);
    loadingControl.hide();
    isPageDisabled.value = false;
  }
};
// 下载按钮点击事件处理函数
const downloadProcessedImages = async () => {
  let filesToDownload = [];

  if (
    actionScope.value.value === "selected" &&
    fileManagerStore.selectedFiles.length > 0
  ) {
    filesToDownload = fileManagerStore.selectedFiles.filter(
      (file) => file.history?.length > 1
    );
  } else {
    if (
      fileManagerStore.currentFile &&
      fileManagerStore.currentFile.history?.length > 1
    ) {
      filesToDownload = [fileManagerStore.currentFile];
    }
  }

  if (filesToDownload.length === 0) {
    $q.notify({
      type: "info",
      message: "没有可下载的处理后图像",
      position: "top",
    });
    return;
  }

  if (!window.electron) {
    $q.notify({
      type: "warning",
      message: "当前环境不支持本地保存处理结果",
      position: "top",
    });
    return;
  }

  if (!effectiveSavePath.value) {
    $q.notify({
      type: "warning",
      message: "请先设置图片输出目录",
      position: "top",
    });
    return;
  }

  const successFiles = [];
  const failedFiles = [];

  for (const file of filesToDownload) {
    const outputFileName = buildProcessedImageOutputName(file);
    const fullPath = joinRendererPath(effectiveSavePath.value, outputFileName);

    try {
      const result = await fileManagerStore.saveFile(file.id, fullPath);
      if (result?.success) {
        successFiles.push(getFileNameFromPath(result.targetPath, outputFileName));
      } else {
        failedFiles.push(`${file.name}: ${result?.error || "保存失败"}`);
      }
    } catch (error) {
      failedFiles.push(`${file.name}: ${error.message}`);
    }
  }

  if (successFiles.length > 0 && failedFiles.length === 0) {
    $q.notify({
      type: "positive",
      message:
        successFiles.length === 1
          ? `已保存 ${successFiles[0]}`
          : `已导出 ${successFiles.length} 张图片`,
      position: "top",
    });
    return;
  }

  if (successFiles.length > 0) {
    $q.notify({
      type: "warning",
      message: `已导出 ${successFiles.length} 张图片，失败 ${failedFiles.length} 张`,
      position: "top",
      timeout: 3500,
    });
    return;
  }

  $q.notify({
    type: "negative",
    message: failedFiles[0] || "保存处理结果失败",
    position: "top",
  });
};
// 检查CUDA可用性
const openCurrentSavePath = async () => {
  if (!canOpenSavePath.value) return;

  try {
    const ensureResult = await window.electron.ipcRenderer.invoke(
      "ensure-directory",
      effectiveSavePath.value
    );
    if (!ensureResult?.success) {
      throw new Error(ensureResult?.error || "创建保存目录失败");
    }

    const result = await window.electron.ipcRenderer.invoke("show-item-in-folder", {
      filePath: effectiveSavePath.value,
    });
    if (!result?.success) {
      throw new Error(result?.error || "打开保存路径失败");
    }
  } catch (error) {
    $q.notify({
      type: "negative",
      message: `打开保存路径失败: ${error.message}`,
      position: "top",
      timeout: 3000,
    });
  }
};

const handleCudaStatusChanged = (status) => {
  cudaAvailable.value = status.available;
  cudaInfo.value = status.info;
};
// 撤销处理
const undoProcessing = () => {
  if (
    !fileManagerStore.currentFile ||
    fileManagerStore.currentFile.history?.length <= 1
  )
    return;

  const success = fileManagerStore.undoProcessing(
    fileManagerStore.currentFile.id
  );

  if (success) {
    $q.notify({
      type: "info",
      message: "已撤销最近的处理",
      position: "top",
    });
  }
};
// 显示原图
const showOriginalImage = async () => {
  if (
    fileManagerStore.currentFile &&
    fileManagerStore.currentFile.history?.length > 1
  ) {
    const originalImage = fileManagerStore.currentFile.history[0];
    if (
      originalImage?.type === "path" &&
      !(await fileManagerStore.fileExists(originalImage.data))
    ) {
      $q.notify({
        type: "warning",
        message: "原图文件已被删除或移动，无法切换到原图对比",
        position: "top",
      });
      return;
    }

    showingOriginal.value = true;
  }
};
// 显示处理后的图片
const showProcessedImage = () => {
  showingOriginal.value = false;
};

// 检查是否需要显示历史记录上限警告
const checkHistoryLimit = (fileId) => {
  if (dontShowMaxHistoryWarning.value) return Promise.resolve(true);

  const file = fileManagerStore.files.find((f) => f.id === fileId);
  const historyLimit = configStore.config.advanced.imageHistoryLimit;
  const maxProcessedCount = historyLimit - 1; // 减去原图

  if (file?.history?.length >= maxProcessedCount) {
    return new Promise((resolve) => {
      $q.dialog({
        title: "历史记录上限提醒",
        message: `该图片已有${historyLimit}个处理记录，继续处理将删除最早的非原图处理记录。`,
        persistent: true,
        ok: {
          label: "确定",
          color: "primary",
        },
        cancel: {
          label: "取消",
          color: "negative",
        },
        options: {
          type: "checkbox",
          model: [dontShowMaxHistoryWarning.value ? "dont_show" : ""],
          items: [
            {
              label: "不再提醒",
              value: "dont_show",
            },
          ],
        },
      })
        .onOk((data) => {
          // 更新不再提醒的状态
          dontShowMaxHistoryWarning.value = data.includes("dont_show");
          resolve(true);
        })
        .onCancel(() => {
          resolve(false);
        });
    });
  }

  return Promise.resolve(true);
};
const saveMaskToFolder = async () => {
  const currentMask = fileManagerStore.currentFile?.mask;
  if (!currentMask || !currentMask.data || !maskFolderPath.value) {
    throw new Error("蒙版数据或蒙版文件夹路径不存在");
  }

  try {
    // 将蒙版数据转换为 Blob
    const response = await fetch(currentMask.displayUrl);
    const blob = await response.blob();

    // 保存蒙版文件
    const maskFileName = "mask_template.png";

    // 检查是否在 Electron 环境中
    if (window.electron) {
      const methodName = "saveFile";
      await window.electron.ipcRenderer.invoke(methodName, {
        filePath: `${maskFolderPath.value}\\${maskFileName}`,
        blob: await blob.arrayBuffer(),
      });

      $q.notify({
        type: "positive",
        message: "蒙版模板已保存到指定文件夹",
        position: "top",
      });
    } else {
      // 浏览器环境下，提示用户手动保存
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = maskFileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      $q.notify({
        type: "info",
        message: "请将下载的蒙版模板保存到蒙版文件夹中",
        position: "top",
      });
    }

    return true;
  } catch (error) {
    console.error("保存蒙版失败:", error);
    throw error;
  }
};
// 监听selectedFiles变化，更新selectAll状态
watch(
  () => fileManagerStore.selectedFiles,
  (newVal) => {
    if (fileManagerStore.files.length > 0) {
      selectAll.value =
        newVal.length ===
        fileManagerStore.files.filter((f) =>
          f.originalFile?.type.startsWith("image/")
        ).length;
    } else {
      selectAll.value = false;
    }
  },
  { deep: true }
);

// 监听当前文件变化
watch(
  () => fileManagerStore.currentFile,
  (newFile) => {
    if (newFile) {
      // 更新应用状态等逻辑
      appStateStore.updatePageState("image", {
        fileExplorer: {
          ...appStateStore.appState.imageState.fileExplorer,
          currentFileId: newFile.id,
        },
      });
    }
  }
);

// 监听 actionScope 变化，当首次选择 folder 时提示选择文件夹
watch(
  () => actionScope.value,
  (newValue) => {
    if (newValue === "folder") {
      // 如果没有设置必要的路径，自动打开右侧设置面板
      if (!folderPath.value || !maskFolderPath.value || !effectiveSavePath.value) {
        rightDrawerOpen.value = true;

        // 显示提示信息
        if (!folderPath.value || !maskFolderPath.value || !effectiveSavePath.value) {
          $q.notify({
            type: "info",
            message: "请在设置面板中设置所有必要的文件夹路径",
            position: "top",
          });
        }
      }
    }
  }
);

// 自动选择第一个文件
watchEffect(() => {
  if (!fileManagerStore.currentFile && fileManagerStore.files.length > 0) {
    fileManagerStore.setCurrentFile(fileManagerStore.files[0].id);
  }
});
const onRejectedFiles = (rejectedEntries) => {
  console.error("Rejected files:", rejectedEntries);

  // 使用 Quasar 的 Notify 插件显示错误信息
  rejectedEntries.forEach((entry) => {
    let msg;
    if (entry.failedPropValidation === "accept") {
      msg = "只支持 PNG、JPG、JPEG 和 WebP 格式的图片文件";
    } else if (entry.failedPropValidation === "duplicate") {
      msg = `文件 "${entry.file.name}" 已存在`;
    } else {
      msg = "文件上传失败";
    }
    $q.notify({
      type: "negative",
      message: msg,
      position: "top",
    });
  });
};

// 处理文件选择
const handleFileSelection = (file) => {
  if (file && file.id) {
    showingOriginal.value = false;
    fileManagerStore.setCurrentFile(file.id);
  }
};

// 处理文件移除
const handleRemoveFile = (fileId) => {
  const file = fileManagerStore.files.find((item) => item.id === fileId);
  if (file) {
    fileManagerStore.removeFile(file.id);

    // 从选中列表中移除
    const selectedIndex = selectedFiles.value.findIndex(
      (f) => f.id === file.id
    );
    if (selectedIndex !== -1) {
      selectedFiles.value.splice(selectedIndex, 1);
    }
  }
};

const syncLayoutFooter = () => {
  if (!layoutFooter) return;

  layoutFooter.setPageFooter({
    owner: imagePageFooterOwner,
    component: ProcessingToolbar,
    className: {
      "pointer-events-none": isPageDisabled.value,
    },
    props: {
      files: fileManagerStore.files,
      selectedFile: currentFile.value?.originalFile || null,
      currentModel: currentModel.value,
      showMaskTools: showMaskTools.value,
      hasProcessedImages: hasProcessedImages.value,
      type: "image",
    },
    listeners: {
      "toggle-file-explorer": () => {
        leftDrawerOpen.value = !leftDrawerOpen.value;
      },
      "rejected-files": onRejectedFiles,
      "toggle-mask-tools": () => {
        showMaskTools.value = !showMaskTools.value;
      },
      "show-original": showOriginalImage,
      "show-processed": showProcessedImage,
      "undo-processing": undoProcessing,
      "run-model": runCurrentModel,
      download: downloadProcessedImages,
      "toggle-settings": () => {
        rightDrawerOpen.value = !rightDrawerOpen.value;
      },
    },
  });
};

const handleDrawerModelChange = (model) => {
  handleModelChange(model);
};

const handleDrawerSelectAllChange = (value) => {
  selectAll.value = value;
  handleSelectAll(value);
};

const syncLayoutDrawers = () => {
  if (!layoutDrawers) return;

  layoutDrawers.setPageDrawer({
    side: "left",
    owner: imagePageLeftDrawerOwner,
    component: FileExplorer,
    className: [
      LEFT_IMAGE_DRAWER_SELECTOR.slice(1),
      { "pointer-events-none": isPageDisabled.value },
    ],
    props: {
      drawerOpen: leftDrawerOpen.value,
      files: fileManagerStore.files,
      selectedFile: currentFile.value,
      selectedFiles: selectedFiles.value,
      fileUrls: fileUrls.value,
    },
    listeners: {
      "update:drawer-open": (value) => {
        leftDrawerOpen.value = value;
      },
      "update:selected-file": handleFileSelection,
      "toggle-selection": toggleFileSelection,
      "remove-file": handleRemoveFile,
    },
  });

  layoutDrawers.setPageDrawer({
    side: "right",
    owner: imagePageRightDrawerOwner,
    component: ImageSettingsDrawer,
    className: [
      RIGHT_IMAGE_DRAWER_SELECTOR.slice(1),
      { "pointer-events-none": isPageDisabled.value },
    ],
    props: {
      drawerOpen: rightDrawerOpen.value,
      currentModel: currentModel.value,
      actionScope: actionScope.value,
      selectAll: selectAll.value,
      selectedFiles: selectedFiles.value,
      currentMask: currentMask.value,
      folderPath: folderPath.value,
      maskFolderPath: maskFolderPath.value,
      savePath: effectiveSavePath.value,
      canOpenSavePath: canOpenSavePath.value,
      ocrLang: ocrLang.value,
      autoLayout: autoLayout.value,
      backendRunning: backendRunning.value,
    },
    listeners: {
      "update:drawer-open": (value) => {
        rightDrawerOpen.value = value;
      },
      "update:current-model": handleDrawerModelChange,
      "update:action-scope": (value) => {
        actionScope.value = value;
      },
      "update:select-all": handleDrawerSelectAllChange,
      "update:folder-path": (value) => {
        folderPath.value = value;
      },
      "update:mask-folder-path": (value) => {
        maskFolderPath.value = value;
      },
      "update:save-path": (value) => {
        savePathSourceMode.value = resolveManagedSavePathMode({
          candidatePath: value,
          downloadPath: exportPath.value,
          folderName: imageFolderName.value,
        });
        savePath.value = resolveEffectiveImageSavePath({
          candidatePath: value,
          downloadPath: exportPath.value,
          folderName: imageFolderName.value,
          sourceMode: savePathSourceMode.value,
        });
      },
      "update:ocr-lang": (value) => {
        ocrLang.value = value;
      },
      "update:auto-layout": (value) => {
        autoLayout.value = value;
      },
      "confirm-delete-selected": confirmDeleteSelected,
      "apply-current-mask-to-selected": applyCurrentMaskToSelected,
      "open-save-path": openCurrentSavePath,
      "cuda-status-changed": handleCudaStatusChanged,
    },
  });
};

watchEffect(() => {
  syncLayoutFooter();
  syncLayoutDrawers();
});

const unwrapElement = (target) => {
  if (typeof target === "string") {
    return document.querySelector(target);
  }

  if (target?.$el instanceof HTMLElement) {
    return target.$el;
  }

  return target instanceof HTMLElement ? target : null;
};

const resolveDrawerElement = (target) => {
  const host = unwrapElement(target);
  if (!host) return null;

  if (host.classList?.contains("q-drawer")) {
    return host;
  }

  return host.querySelector(".q-drawer");
};

const getDrawerOverlapInset = (containerRect, drawerEl, side, isOpen) => {
  if (!isOpen || !containerRect || !drawerEl) return 0;

  const rect = drawerEl.getBoundingClientRect();
  const style = window.getComputedStyle(drawerEl);

  if (
    rect.width <= 1 ||
    rect.height <= 1 ||
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.opacity === "0"
  ) {
    return 0;
  }

  if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom) {
    return 0;
  }

  if (side === "left") {
    return Math.max(0, Math.min(containerRect.width, rect.right - containerRect.left));
  }

  return Math.max(0, Math.min(containerRect.width, containerRect.right - rect.left));
};

const updateVisibleAreaInsets = () => {
  const containerEl = unwrapElement(imageStageRef.value);
  if (!containerEl) return;

  const containerRect = containerEl.getBoundingClientRect();
  visibleAreaInsets.value = {
    left: getDrawerOverlapInset(
      containerRect,
      resolveDrawerElement(LEFT_IMAGE_DRAWER_SELECTOR),
      "left",
      leftDrawerOpen.value
    ),
    right: getDrawerOverlapInset(
      containerRect,
      resolveDrawerElement(RIGHT_IMAGE_DRAWER_SELECTOR),
      "right",
      rightDrawerOpen.value
    ),
    top: 0,
    bottom: 0,
  };
};

const cancelVisibleAreaUpdateFrame = () => {
  if (!visibleAreaUpdateFrame) return;
  cancelAnimationFrame(visibleAreaUpdateFrame);
  visibleAreaUpdateFrame = 0;
};

const cancelVisibleAreaTransitionSync = () => {
  if (!visibleAreaTransitionFrame) return;
  cancelAnimationFrame(visibleAreaTransitionFrame);
  visibleAreaTransitionFrame = 0;
};

const scheduleVisibleAreaInsetsUpdate = () => {
  cancelVisibleAreaUpdateFrame();
  visibleAreaUpdateFrame = requestAnimationFrame(() => {
    visibleAreaUpdateFrame = 0;
    updateVisibleAreaInsets();
  });
};

const startVisibleAreaTransitionSync = (duration = 420) => {
  cancelVisibleAreaTransitionSync();

  const endTime = performance.now() + duration;
  const tick = () => {
    updateVisibleAreaInsets();
    if (performance.now() < endTime) {
      visibleAreaTransitionFrame = requestAnimationFrame(tick);
      return;
    }

    visibleAreaTransitionFrame = 0;
  };

  visibleAreaTransitionFrame = requestAnimationFrame(tick);
};

const disconnectVisibleAreaResizeObserver = () => {
  if (!visibleAreaResizeObserver) return;
  visibleAreaResizeObserver.disconnect();
  visibleAreaResizeObserver = null;
};

const syncVisibleAreaObservers = async () => {
  disconnectVisibleAreaResizeObserver();

  if (typeof ResizeObserver === "undefined") {
    return;
  }

  await nextTick();

  const observedElements = [
    unwrapElement(imageStageRef.value),
    resolveDrawerElement(LEFT_IMAGE_DRAWER_SELECTOR),
    resolveDrawerElement(RIGHT_IMAGE_DRAWER_SELECTOR),
  ].filter(Boolean);

  if (!observedElements.length) {
    return;
  }

  visibleAreaResizeObserver = new ResizeObserver(() => {
    scheduleVisibleAreaInsetsUpdate();
  });

  observedElements.forEach((element) => {
    visibleAreaResizeObserver.observe(element);
  });
};

// 页面离开时的状态保存
const savePageState = async () => {
  try {
    // 保存fileManager状态
    appStateStore.saveFileManagerState("image", fileManagerStore);

    // 保存UI状态
    const uiState = {
      leftDrawerOpen: leftDrawerOpen.value,
      rightDrawerOpen: rightDrawerOpen.value,
      currentModel: currentModel.value,
      showMaskTools: showMaskTools.value,
      actionScope: actionScope.value,
      selectAll: selectAll.value,
      savePath: effectiveSavePath.value,
      savePathSourceMode: savePathSourceMode.value,
      folderPath: folderPath.value,
      maskFolderPath: maskFolderPath.value,
      ocrLang: ocrLang.value,
      autoLayout: autoLayout.value,
      showingOriginal: showingOriginal.value,
      dontShowMaxHistoryWarning: dontShowMaxHistoryWarning.value,
      dontShowBackendWarning: dontShowBackendWarning.value,
    };
    appStateStore.saveUIState("image", uiState);

    // 持久化到磁盘
    const result = await appStateStore.saveState();
    if (result.success) {
      console.log("页面状态已保存");
    } else {
      console.error("保存页面状态失败:", result.error);
    }
  } catch (error) {
    console.error("保存页面状态失败:", error);
  }
};

// 页面进入时的状态恢复
const restorePageState = async () => {
  try {
    // 恢复fileManager状态
    const savedFileManagerState = appStateStore.restoreFileManagerState("image");
    if (savedFileManagerState) {
      // fileManagerStore.restoreFromState(savedFileManagerState);
      // 如果有当前文件，确保正确选中
      if (fileManagerStore.currentFileId) {
        const currentFile = fileManagerStore.files.find(
          f => f.id === fileManagerStore.currentFileId
        );
        if (currentFile) {
          // 触发文件选择事件，确保UI状态同步
          handleFileSelection(currentFile);
        }
      }
    }
    // 恢复UI状态
    const savedUIState = appStateStore.restoreUIState("image");
    if (savedUIState) {
      // 使用nextTick确保状态更新的正确时机
      await nextTick(() => {
        leftDrawerOpen.value = savedUIState.leftDrawerOpen ?? defaultDrawerState.left;
        rightDrawerOpen.value = savedUIState.rightDrawerOpen ?? defaultDrawerState.right;
        currentModel.value = savedUIState.currentModel || "lama";
        showMaskTools.value = savedUIState.showMaskTools ?? true;
        setMaskDrawingMode(runtimeUiStore.imageMaskDrawingEnabled);
        actionScope.value = savedUIState.actionScope || {
          label: "仅当前文件",
          value: "current",
        };
        selectAll.value = savedUIState.selectAll ?? false;
        savePath.value = savedUIState.savePath || "";
        savePathSourceMode.value = savedUIState.savePathSourceMode || "managed";
        folderPath.value = savedUIState.folderPath || "";
        maskFolderPath.value = savedUIState.maskFolderPath || "";
        ocrLang.value = savedUIState.ocrLang || "中文";
        autoLayout.value = savedUIState.autoLayout ?? true;
        showingOriginal.value = savedUIState.showingOriginal ?? false;
        dontShowMaxHistoryWarning.value = savedUIState.dontShowMaxHistoryWarning ?? false;
        dontShowBackendWarning.value = savedUIState.dontShowBackendWarning ?? false;
      });
      await nextTick();
      updateVisibleAreaInsets();
      // 应用恢复后的状态副作用
      if (selectAll.value) {
        fileManagerStore.selectAllFiles(true);
      }
    }
  } catch (error) {
    console.error("恢复页面状态失败:", error);
  }
};

onMounted(async () => {
  // 1. 首先加载配置
  await configStore.loadConfig();
  runtimeUiStore.ensureImageMaskToolState(configStore.config.advanced?.imageBrushDefault);

  // 2. 然后初始化fileManager配置（使用正确的配置）
  fileManagerStore.initProcessingConfig();

  // 3. 恢复页面状态
  await restorePageState();

  // 4. 应用配置到UI状态
  if (configStore.config.fileManagement) {
    syncManagedImageOutputPath(configStore.config.fileManagement);
  }

  // 5. 设置配置更新监听器
  if (window.electron) {
    isElectron.value = true;

    // 获取资源路径
    try {
      resourcesPath.value = await window.electron.ipcRenderer.invoke(
        "get-resources-path"
      );
    } catch (error) {
      console.error("获取资源路径失败:", error);
    }

    // 监听配置更新
    window.electron.ipcRenderer.on("config-updated", (event, config) => {
      if (config.fileManagement) {
        syncManagedImageOutputPath(config.fileManagement);
      }
    });
  }

  // 6. 应用恢复后的状态副作用
  await nextTick(() => {
    // 确保selectAll状态正确应用
    if (selectAll.value) {
      fileManagerStore.selectAllFiles(true);
    }
    updateVisibleAreaInsets();
  });

  await syncVisibleAreaObservers();
  window.addEventListener("resize", scheduleVisibleAreaInsetsUpdate);
});

// 在路由离开前保存当前页面状态
onBeforeRouteLeave(async (to, from, next) => {
  layoutFooter?.clearPageFooter?.(imagePageFooterOwner);
  layoutDrawers?.clearPageDrawer?.("left", imagePageLeftDrawerOwner);
  layoutDrawers?.clearPageDrawer?.("right", imagePageRightDrawerOwner);
  // 保存当前页面状态
  await savePageState();
  next();
});
// 在组件卸载时清理资源
onUnmounted(async () => {
  layoutFooter?.clearPageFooter?.(imagePageFooterOwner);
  layoutDrawers?.clearPageDrawer?.("left", imagePageLeftDrawerOwner);
  layoutDrawers?.clearPageDrawer?.("right", imagePageRightDrawerOwner);
  window.removeEventListener("resize", scheduleVisibleAreaInsetsUpdate);
  cancelVisibleAreaUpdateFrame();
  cancelVisibleAreaTransitionSync();
  disconnectVisibleAreaResizeObserver();
  // 保存状态
  await savePageState();

  // 清理资源
  fileManagerStore.files.forEach((file) => {
    if (file.image?.displayUrl && file.image.displayUrl.startsWith("blob:")) {
      URL.revokeObjectURL(file.image.displayUrl);
    }
    file.history?.forEach((historyItem) => {
      if (
        historyItem.displayUrl &&
        historyItem.displayUrl.startsWith("blob:")
      ) {
        URL.revokeObjectURL(historyItem.displayUrl);
      }
    });
  });
});

watch(
  [leftDrawerOpen, rightDrawerOpen, currentFile, showMaskTools],
  async () => {
    await nextTick();
    scheduleVisibleAreaInsetsUpdate();
  },
  {
    flush: "post",
  }
);

watch(
  [leftDrawerOpen, rightDrawerOpen],
  async () => {
    await syncVisibleAreaObservers();
    startVisibleAreaTransitionSync();
  },
  {
    flush: "post",
  }
);
</script>
<style scoped>
.page-disabled-overlay {
  position: absolute;
  top: 50px; /* 设置为头部高度，避免遮住头部工具栏 */
  left: 0;
  width: 100vw;
  top: 0;
  width: 100%;
  height: calc(100vh - 50px); /* 减去头部高度 */
  background-color: rgba(0, 0, 0, 0.1);
  z-index: 1200;
  height: 100%;
  cursor: not-allowed;
}

.pointer-events-none {
  pointer-events: none;
  user-select: none;
}

.image-page {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.image-work-area {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  box-sizing: border-box;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.image-stage-shell {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  --preview-grid-cell-a: #161616;
  --preview-grid-cell-b: #202020;
}
</style>
