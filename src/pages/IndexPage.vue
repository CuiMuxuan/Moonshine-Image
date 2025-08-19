<template>
  <q-page class="flex">
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
    <!-- 左侧文件浏览器 -->
    <file-explorer
      v-model:drawer-open="leftDrawerOpen"
      :files="fileManagerStore.files"
      :selected-file="currentFile"
      :selected-files="selectedFiles"
      :file-urls="fileUrls"
      :class="{ 'pointer-events-none': isPageDisabled }"
      @update:selected-file="handleFileSelection"
      @toggle-selection="toggleFileSelection"
      @remove-file="handleRemoveFile"
    />

    <!-- 右侧设置面板 -->
    <q-drawer show-if-above v-model="rightDrawerOpen" side="right" bordered>
      <div class="q-pa-md" :class="{ 'pointer-events-none': isPageDisabled }">
        <div class="text-h6 q-mb-md flex items-center">
          <q-icon name="settings" class="q-mr-sm" />
          运行设置
        </div>

        <!-- 模型选择器 -->
        <q-item>
          <q-item-section>
            <model-selector
              v-model="currentModel"
              type="image"
              @update:model-value="handleModelChange"
            />
          </q-item-section>
        </q-item>

        <!-- 动态设置内容 -->
        <div v-if="currentModel === 'lama'">
          <!-- Lama模型设置 -->
          <q-list>
            <q-item>
              <q-item-section>
                <q-select
                  v-model="actionScope"
                  :options="[
                    { label: '仅当前文件', value: 'current' },
                    { label: '仅选中文件', value: 'selected' },
                    { label: '选中文件夹', value: 'folder' },
                  ]"
                  label="作用范围"
                  filled
                />
              </q-item-section>
            </q-item>

            <q-item>
              <q-item-section>
                <q-toggle
                  v-model="selectAll"
                  label="全选文件"
                  @update:model-value="handleSelectAll"
                />
              </q-item-section>
            </q-item>

            <q-item>
              <q-item-section>
                <q-btn
                  color="negative"
                  icon="delete"
                  label="删除选中文件"
                  :disable="selectedFiles.length === 0"
                  @click="confirmDeleteSelected"
                />
              </q-item-section>
            </q-item>
            <q-item>
              <q-item-section>
                <q-btn
                  color="primary"
                  icon="content_copy"
                  label="当前蒙版作用于选中文件"
                  :disable="selectedFiles.length === 0 || !currentMask?.data"
                  @click="applyCurrentMaskToSelected"
                />
              </q-item-section>
            </q-item>
            <q-item v-if="actionScope.value === 'folder'">
              <q-item-section>
                <folder-selector v-model="folderPath" label="输入文件夹" />
              </q-item-section>
            </q-item>

            <q-item v-if="actionScope.value === 'folder'">
              <q-item-section>
                <folder-selector v-model="maskFolderPath" label="蒙版文件夹" />
              </q-item-section>
            </q-item>

            <q-item>
              <q-item-section>
                <folder-selector v-model="savePath" label="保存路径" />
              </q-item-section>
            </q-item>

            <q-item>
              <q-item-section>
                <cuda-status
                  @cuda-status-changed="handleCudaStatusChanged"
                  :backend-running="backendRunning"
                />
              </q-item-section>
            </q-item>
          </q-list>
        </div>

        <div v-else-if="currentModel === 'ocr'">
          <!-- OCR设置 -->
          <q-list>
            <q-item>
              <q-item-section>
                <q-select
                  v-model="ocrLang"
                  :options="['中文', '英文', '日文']"
                  label="识别语言"
                  filled
                />
              </q-item-section>
            </q-item>
            <q-item>
              <q-item-section>
                <q-toggle v-model="autoLayout" label="自动版面分析" />
              </q-item-section>
            </q-item>
            <div class="text-h6">OCR功能将在作者B站粉丝超过2000时开发</div>
          </q-list>
        </div>
        <div v-else class="text-h6">修复功能将在作者B站粉丝超过3000时开发</div>
      </div>
    </q-drawer>

    <!-- 主工作区 -->
    <div class="col flex row">
      <div class="col">
        <workspace
          :selected-file="currentFile"
          :class="{ 'pointer-events-none': isPageDisabled }"
        >
          <ImageEditor
            v-if="
              currentFile && currentFile.originalFile?.type.startsWith('image/')
            "
            ref="editorRef"
            :selected-file="currentFile.originalFile"
            :show-masker="showMaskTools"
            :mask="currentFile.mask"
            :image-url="currentDisplayUrl"
            @loaded="handleImageLoaded"
            @update:mask="handleMaskUpdate"
          />
        </workspace>
      </div>

      <!-- 底部工具栏 -->
      <processing-toolbar
        :files="fileManagerStore.files"
        :selected-file="currentFile?.originalFile"
        :current-model="currentModel"
        :show-mask-tools="showMaskTools"
        :has-processed-images="hasProcessedImages"
        type="image"
        :class="{ 'pointer-events-none': isPageDisabled }"
        @toggle-file-explorer="leftDrawerOpen = !leftDrawerOpen"
        @rejected-files="onRejectedFiles"
        @toggle-mask-tools="showMaskTools = !showMaskTools"
        @show-original="showOriginalImage"
        @show-processed="showProcessedImage"
        @undo-processing="undoProcessing"
        @run-model="runCurrentModel"
        @download="downloadProcessedImages"
        @toggle-settings="rightDrawerOpen = !rightDrawerOpen"
      />
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
import InpaintService from "src/services/ImageProcessingService";
import ImageEditor from "../components/ImageEditor.vue";
import FileExplorer from "../components/FileExplorer.vue";
import Workspace from "../components/Workspace.vue";
import ModelSelector from "../components/ModelSelector.vue";
import ProcessingToolbar from "../components/ImageProcessingToolbar.vue";
import FolderSelector from "../components/FolderSelector.vue";
import CudaStatus from "../components/CudaStatus.vue";
import { onBeforeRouteLeave } from "vue-router";

const $q = useQuasar();
const configStore = useConfigStore();
const appStateStore = useAppStateStore();
const fileManagerStore = useFileManagerStore();

const leftDrawerOpen = ref(false);
const rightDrawerOpen = ref(false);
const currentModel = ref("lama");
const showMaskTools = ref(true);
const actionScope = ref({ label: "仅当前文件", value: "current" });
const selectAll = ref(false);
const exportPath = ref("");
const imageFolderName = ref("");
const savePath = ref("");
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
const props = defineProps({
  backendRunning: {
    type: Boolean,
    default: false,
  },
});
const backendRunning = computed(() => props.backendRunning);
const loadingControl = inject("loadingControl");
const isPageDisabled = ref(false);
const currentFile = computed(() => fileManagerStore.currentFile);
const selectedFiles = computed(() => fileManagerStore.selectedFiles);
const currentDisplayUrl = computed(() => {
  const displayImage = fileManagerStore.getCurrentDisplayImage;
  return displayImage?.displayUrl || null;
});
const currentMask = computed(() => {
  return currentFile.value?.mask || null;
});
const hasProcessedImages = computed(() => {
  return currentFile.value?.history?.length > 1 || false;
});

// 提供编辑器引用
provide("editor-ref", editorRef);
provide("image-editor", editorRef);

const fileUrls = computed(() => {
  const urls = {};
  fileManagerStore.files.forEach((file) => {
    const latestImage = file.history[file.history.length - 1];
    urls[file.name] = latestImage?.displayUrl || null;
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
};
const handleMaskUpdate = (maskData) => {
  if (fileManagerStore.currentFile) {
    fileManagerStore.updateFileMask(fileManagerStore.currentFile.id, maskData);
  }
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
    const targetDimensions = await getImageDimensions(targetFile.originalFile);

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
// 获取图片尺寸的辅助函数
const getImageDimensions = (file) => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve({
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
      URL.revokeObjectURL(img.src); // 释放内存
    };
    img.onerror = () => {
      reject(new Error("无法加载图片"));
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
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

    if (!savePath.value) {
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
    if (response.results && response.results.length > 0) {
      // 显示成功通知
      $q.notify({
        type: "positive",
        message: `成功处理了 ${
          response.results.filter((r) => r.success).length
        } 张图像，总共 ${response.processed_count} 张`,
        position: "top",
      });
    } else {
      throw new Error("处理结果为空");
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
    loadingControl.hide();
    isPageDisabled.value = false;
  }
};

const processFolderImages = async () => {
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
      output_folder: savePath.value,
    };
    // 调用文件夹处理API
    const response = await InpaintService.performFolderInpainting(folderData);
    // 处理返回结果
    if (response.success) {
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

  // 使用 fileManagerStore.saveFile 保存文件
  for (const file of filesToDownload) {
    const fileName = file.name;
    const fileNameWithoutExt =
      fileName.substring(0, fileName.lastIndexOf(".")) || fileName;
    const fileExt = fileName.substring(fileName.lastIndexOf(".")) || ".png";
    const newFileName = `${fileNameWithoutExt}_processed${fileExt}`;
    const fullPath = `${savePath.value}\\${newFileName}`;

    try {
      await fileManagerStore.saveFile(file.id, fullPath);
      $q.notify({
        type: "positive",
        message: `已保存: ${newFileName}`,
        position: "top",
      });
    } catch (error) {
      $q.notify({
        type: "negative",
        message: `保存失败: ${fileName}，${error.message}`,
        position: "top",
      });
    }
  }
};
// 检查CUDA可用性
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
const showOriginalImage = () => {
  if (
    fileManagerStore.currentFile &&
    fileManagerStore.currentFile.history?.length > 1
  ) {
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
      if (!folderPath.value || !maskFolderPath.value || !savePath.value) {
        rightDrawerOpen.value = true;

        // 显示提示信息
        if (!folderPath.value || !maskFolderPath.value || !savePath.value) {
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
    fileManagerStore.setCurrentFile(file.id);
  }
};

// 处理文件移除
const handleRemoveFile = (index) => {
  const file = fileManagerStore.files[index];
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
      savePath: savePath.value,
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
        leftDrawerOpen.value = savedUIState.leftDrawerOpen ?? false;
        rightDrawerOpen.value = savedUIState.rightDrawerOpen ?? false;
        currentModel.value = savedUIState.currentModel || "lama";
        showMaskTools.value = savedUIState.showMaskTools ?? true;
        actionScope.value = savedUIState.actionScope || {
          label: "仅当前文件",
          value: "current",
        };
        selectAll.value = savedUIState.selectAll ?? false;
        savePath.value = savedUIState.savePath || "";
        folderPath.value = savedUIState.folderPath || "";
        maskFolderPath.value = savedUIState.maskFolderPath || "";
        ocrLang.value = savedUIState.ocrLang || "中文";
        autoLayout.value = savedUIState.autoLayout ?? true;
        showingOriginal.value = savedUIState.showingOriginal ?? false;
        dontShowMaxHistoryWarning.value = savedUIState.dontShowMaxHistoryWarning ?? false;
        dontShowBackendWarning.value = savedUIState.dontShowBackendWarning ?? false;
      });
      await nextTick();
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

  // 2. 然后初始化fileManager配置（使用正确的配置）
  fileManagerStore.initProcessingConfig();

  // 3. 恢复页面状态
  await restorePageState();

  // 4. 应用配置到UI状态
  if (configStore.config.fileManagement) {
    if (configStore.config.fileManagement.imageFolderName) {
      imageFolderName.value = configStore.config.fileManagement.imageFolderName;
    }
    if (configStore.config.fileManagement.downloadPath) {
      exportPath.value = configStore.config.fileManagement.downloadPath;
      if (!savePath.value) {
        savePath.value = configStore.config.fileManagement.downloadPath;
      }
    }
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
      if (config.fileManagement && config.fileManagement.imageFolderName) {
        imageFolderName.value = config.fileManagement.imageFolderName;
      }
      if (config.fileManagement && config.fileManagement.downloadPath) {
        exportPath.value = config.fileManagement.downloadPath;
        savePath.value = config.fileManagement.downloadPath;
      }
    });
  }

  // 6. 应用恢复后的状态副作用
  await nextTick(() => {
    // 确保selectAll状态正确应用
    if (selectAll.value) {
      fileManagerStore.selectAllFiles(true);
    }
  });
});

// 在路由离开前保存当前页面状态
onBeforeRouteLeave(async (to, from, next) => {
  // 保存当前页面状态
  await savePageState();
  next();
});
// 在组件卸载时清理资源
onUnmounted(async () => {
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
</script>
<style scoped>
.page-disabled-overlay {
  position: fixed;
  top: 50px; /* 设置为头部高度，避免遮住头部工具栏 */
  left: 0;
  width: 100vw;
  height: calc(100vh - 50px); /* 减去头部高度 */
  background-color: rgba(0, 0, 0, 0.1);
  z-index: 9999;
  cursor: not-allowed;
}

.pointer-events-none {
  pointer-events: none;
  user-select: none;
}
</style>
