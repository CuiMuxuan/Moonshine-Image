<template>
  <q-page class="flex">
    <!-- 左侧文件浏览器 -->
    <file-explorer
      v-model:drawer-open="leftDrawerOpen"
      :files="files"
      :selected-file="selectedFile"
      :selected-files="selectedFiles"
      :file-urls="fileUrls"
      @update:selected-file="selectedFile = $event"
      @toggle-selection="toggleFileSelection"
      @remove-file="removeFile"
    />

    <!-- 右侧设置面板 -->
    <q-drawer show-if-above v-model="rightDrawerOpen" side="right" bordered>
      <div class="q-pa-md">
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
                  :disable="
                    selectedFiles.length === 0 ||
                    !currentMask ||
                    !currentMask.data
                  "
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
                <cuda-status @cuda-status-changed="handleCudaStatusChanged" />
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
        <workspace :selected-file="selectedFile">
          <ImageEditor
            v-if="selectedFile && selectedFile.type.startsWith('image/')"
            ref="editorRef"
            :selected-file="selectedFile"
            :show-masker="showMaskTools"
            :mask="currentMask"
            :image-url="fileUrl"
            @loaded="handleImageLoaded"
            @update:mask="handleMaskUpdate"
          />
        </workspace>
      </div>

      <!-- 底部工具栏 -->
      <processing-toolbar
        :files="files"
        :selected-file="selectedFile"
        :current-model="currentModel"
        :show-mask-tools="showMaskTools"
        :has-processed-images="!!processedImages[selectedFile?.name]?.length"
        type="image"
        @toggle-file-explorer="leftDrawerOpen = !leftDrawerOpen"
        @update:files="files = $event"
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
} from "vue";
import { useQuasar } from "quasar";
import { useEditorStore } from "src/stores/editor";
import { useConfigStore } from "src/stores/config";
import { useAppStateStore } from "src/stores/appState";
import InpaintService from "src/services/InpaintService";
import ImageEditor from "../components/ImageEditor.vue";
import FileExplorer from "../components/FileExplorer.vue";
import Workspace from "../components/Workspace.vue";
import ModelSelector from "../components/ModelSelector.vue";
import ProcessingToolbar from "../components/ProcessingToolbar.vue";
import FolderSelector from "../components/FolderSelector.vue";
import CudaStatus from "../components/CudaStatus.vue";
import { onBeforeRouteLeave } from "vue-router";

const $q = useQuasar();
const store = useEditorStore();
const configStore = useConfigStore();
const appStateStore = useAppStateStore();

const leftDrawerOpen = ref(false);
const rightDrawerOpen = ref(false);
const files = ref([]);
const selectedFile = ref(null);
const selectedFiles = ref([]);
const currentModel = ref("lama");
const showMaskTools = ref(true);
const actionScope = ref({ label: "仅当前文件", value: "current" });
const selectAll = ref(false);
const savePath = ref("");
const folderPath = ref("");
const maskFolderPath = ref("");
const ocrLang = ref("中文");
const autoLayout = ref(true);
const currentMask = ref(null);
const processedImages = ref({});
const editorRef = ref(null);
const isImageLoaded = ref(false);
const showingOriginal = ref(false);
const masks = ref({});
const cudaAvailable = ref(false);
const cudaInfo = ref({});
const dontShowMaxHistoryWarning = ref(false);
const isElectron = ref(false);
const resourcesPath = ref("");

// 提供编辑器引用
provide("editor-ref", editorRef);
provide("image-editor", editorRef);

// 计算属性
const filteredFiles = computed(() =>
  files.value.filter((f) => f.type.startsWith("image/"))
);

const fileUrls = computed(() => {
  const urls = {};
  filteredFiles.value.forEach((file) => {
    if (!urls[file.name]) {
      if (!showingOriginal.value && processedImages.value[file.name]?.length) {
        const history = processedImages.value[file.name];
        urls[file.name] = history[history.length - 1];
      } else {
        urls[file.name] = URL.createObjectURL(file);
      }
    }
  });
  return urls;
});

const fileUrl = computed(() => {
  return selectedFile.value ? fileUrls.value[selectedFile.value.name] : null;
});

// 切换文件选择
const toggleFileSelection = (file) => {
  const index = selectedFiles.value.findIndex((f) => f.name === file.name);
  if (index === -1) {
    selectedFiles.value.push(file);
  } else {
    selectedFiles.value.splice(index, 1);
  }
};

const handleModelChange = (model) => {
  currentModel.value = model;
  $q.notify({
    type: "info",
    message: `已切换到${model}模型`,
    position: "top",
  });
};

const handleSelectAll = (val) => {
  if (val) {
    selectedFiles.value = [...filteredFiles.value];
  } else {
    selectedFiles.value = [];
  }
};

const handleImageLoaded = () => {
  isImageLoaded.value = true;
};

const handleMaskUpdate = (maskData) => {
  if (selectedFile.value) {
    masks.value[selectedFile.value.name] = maskData;
    currentMask.value = maskData;
  }
};
// 更新蒙版数据
// const updateMask = (fileName, maskData) => {
//   if (masks.value[fileName]) {
//     masks.value[fileName] = maskData;
//     // 如果当前选中的文件就是被更新的文件，直接更新currentMask
//     if (selectedFile.value && selectedFile.value.name === fileName) {
//       currentMask.value = maskData;
//     }
//   }
// };

// 删除文件时同时删除对应的蒙版
const removeFile = (index) => {
  const removed = files.value.splice(index, 1)[0];
  // 删除对应的蒙版
  if (removed && masks.value[removed.name]) {
    delete masks.value[removed.name];
  }

  if (selectedFile.value?.name === removed.name) {
    selectedFile.value = filteredFiles.value[0] || null;
  }
};

// 确认删除选中文件时同时删除对应的蒙版
const confirmDeleteSelected = () => {
  if (selectedFiles.value.length === 0) return;

  $q.dialog({
    title: "确认删除",
    message: `确定要删除选中的 ${selectedFiles.value.length} 个文件吗？`,
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
    const filesToRemove = selectedFiles.value.map((f) => f.name);

    // 同时删除对应的蒙版
    filesToRemove.forEach((fileName) => {
      if (masks.value[fileName]) {
        delete masks.value[fileName];
      }
    });

    files.value = files.value.filter((f) => !filesToRemove.includes(f.name));

    // 如果当前选中的文件被删除，重新选择第一个文件
    if (selectedFile.value && filesToRemove.includes(selectedFile.value.name)) {
      selectedFile.value = filteredFiles.value[0] || null;
    }

    // 清空选中文件列表
    selectedFiles.value = [];
  });
};

// 选中文件适应当前蒙版
const applyCurrentMaskToSelected = async () => {
  if (!selectedFile.value || !currentMask.value || !currentMask.value.data) {
    return;
  }

  // 获取当前蒙版
  const sourceMask = currentMask.value;

  // 应用到所有选中文件
  for (const file of selectedFiles.value) {
    if (
      file.name !== selectedFile.value.name &&
      file.type.startsWith("image/")
    ) {
      try {
        // 获取目标图片的尺寸
        const targetDimensions = await getImageDimensions(file);

        // 调整蒙版大小
        const resizedMaskData = await resizeMaskData(
          sourceMask.data,
          sourceMask.width,
          sourceMask.height,
          targetDimensions.width,
          targetDimensions.height
        );

        // 更新蒙版数据
        masks.value[file.name] = {
          data: resizedMaskData,
          width: targetDimensions.width,
          height: targetDimensions.height,
        };
      } catch (error) {
        console.error(`调整蒙版失败: ${file.name}`, error);
      }
    }
  }

  $q.notify({
    type: "positive",
    message: "已将当前蒙版应用到选中文件",
    position: "top",
  });
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
const runCurrentModel = () => {
  if (!selectedFile.value) return;

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
    if (!currentMask.value || !currentMask.value.data) {
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
    selectedFiles.value.length > 0
  ) {
    // 处理所有选中的文件
    filesToProcess = selectedFiles.value.filter(
      (file) => file.type.startsWith("image/") && masks.value[file.name]?.data
    );
  } else {
    // 只处理当前选中的文件
    if (selectedFile.value && currentMask.value && currentMask.value.data) {
      filesToProcess = [selectedFile.value];
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
    const proceed = await checkHistoryLimit(file.name);
    if (!proceed) return;
  }

  try {
    // 显示加载状态
    $q.loading.show({
      message: `正在处理 ${filesToProcess.length} 张图像，请稍候...`,
    });

    // 准备批量处理的数据
    const images = [];
    const masksList = [];
    const fileNames = [];

    // 从文件和蒙版中提取base64数据
    for (const file of filesToProcess) {
      try {
        // 获取图像的base64 - 使用最新处理后的图片或原图
        let imageBase64;
        if (processedImages.value[file.name]?.length) {
          // 检查是否有存储的 blob
          if (
            processedImages.value[file.name + "_blobs"]?.[
              processedImages.value[file.name].length - 1
            ]
          ) {
            // 直接使用存储的 blob 对象
            const blob =
              processedImages.value[file.name + "_blobs"][
                processedImages.value[file.name].length - 1
              ];
            imageBase64 = await InpaintService.fileToBase64(
              new File([blob], file.name, { type: "image/png" })
            );
          } else {
            // 如果没有存储 blob（兼容旧数据），使用原图
            imageBase64 = await InpaintService.fileToBase64(file);
          }
        } else {
          // 使用原图
          imageBase64 = await InpaintService.fileToBase64(file);
        }

        images.push(imageBase64);

        // 获取对应的蒙版
        const mask = masks.value[file.name];
        if (mask && mask.data) {
          masksList.push(mask.data);
          fileNames.push(file.name);
        } else {
          // 如果没有蒙版，跳过这个文件
          images.pop();
          continue;
        }
      } catch (err) {
        console.error(`处理文件 ${file.name} 时出错:`, err);
      }
    }

    if (images.length === 0) {
      throw new Error("没有有效的图像和蒙版可以处理");
    }

    // 构造请求体
    const requestData = {
      images: images.map((img) => InpaintService.getBase64FromDataURL(img)),
      masks: masksList.map((mask) => InpaintService.getBase64FromDataURL(mask)),
    };

    // 调用批量处理API
    const response = await InpaintService.performBatchInpainting(requestData);

    // 处理返回的结果
    if (response.results && response.results.length > 0) {
      // 处理结果并更新历史记录
      for (let i = 0; i < response.results.length; i++) {
        const result = response.results[i];
        if (result.success) {
          const fileName = fileNames[i];

          // 将 base64 转换为 Blob 对象
          const base64Data = result.image.split(",")[1];
          const byteCharacters = atob(base64Data);
          const byteArrays = [];

          for (let offset = 0; offset < byteCharacters.length; offset += 512) {
            const slice = byteCharacters.slice(offset, offset + 512);
            const byteNumbers = new Array(slice.length);
            for (let i = 0; i < slice.length; i++) {
              byteNumbers[i] = slice.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            byteArrays.push(byteArray);
          }

          const blob = new Blob(byteArrays, { type: "image/png" });
          // 创建处理后图片的URL
          const resultImageUrl = URL.createObjectURL(blob);
          // 初始化历史记录数组（如果不存在）
          if (!processedImages.value[fileName]) {
            processedImages.value[fileName] = [];
          }
          const historyLimit = configStore.config.advanced.imageHistoryLimit;
          const maxProcessedCount = historyLimit - 1; // 减去原图

          // 初始化 blob 存储数组（如果不存在）
          if (!processedImages.value[fileName + "_blobs"]) {
            processedImages.value[fileName + "_blobs"] = [];
          }
          // 如果历史记录达到上限，删除最早的非原图记录
          if (processedImages.value[fileName].length >= maxProcessedCount) {
            URL.revokeObjectURL(processedImages.value[fileName][0]); // 释放 URL
            processedImages.value[fileName].shift();
            processedImages.value[fileName + "_blobs"].shift(); // 同时删除对应的 blob
          }

          // 添加新的处理记录
          processedImages.value[fileName].push(resultImageUrl);
          processedImages.value[fileName + "_blobs"].push(blob); // 存储 blob 对象

          // 重置原始文件的蒙版
          if (masks.value[fileName]) {
            // 创建新的蒙版对象，确保 Vue 能检测到变化
            const newMask = {
              data: null,
              width: masks.value[fileName].width,
              height: masks.value[fileName].height,
            };
            masks.value[fileName] = newMask;

            // 如果是当前选中的文件，更新当前蒙版
            if (selectedFile.value && selectedFile.value.name === fileName) {
              currentMask.value = { ...newMask };
            }
          }
        }
      }
      // 强制刷新视图 - 先显示原图再切回处理后的图片
      showingOriginal.value = true;
      setTimeout(() => {
        showingOriginal.value = false;
      }, 50);

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
    $q.loading.hide();
  }
};
const processFolderImages = async () => {
  try {
    // 显示加载状态
    $q.loading.show({
      message: "正在准备处理文件夹中的图像...",
    });

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
    $q.loading.hide();
  }
};
// 下载按钮点击事件处理函数
const downloadProcessedImages = async () => {
  // 确定要下载的文件列表
  let filesToDownload = [];
  if (
    actionScope.value.value === "selected" &&
    selectedFiles.value.length > 0
  ) {
    // 下载所有选中的文件
    filesToDownload = selectedFiles.value.filter(
      (file) =>
        file.type.startsWith("image/") &&
        processedImages.value[file.name]?.length
    );
  } else {
    // 只下载当前选中的文件
    if (
      selectedFile.value &&
      processedImages.value[selectedFile.value.name]?.length
    ) {
      filesToDownload = [selectedFile.value];
    }
  }

  if (filesToDownload.length === 0) {
    $q.notify({
      type: "negative",
      message: "没有可下载的处理后图像",
      position: "top",
    });
    return;
  }

  // 检查保存路径是否存在
  if (!savePath.value) {
    $q.notify({
      type: "negative",
      message: "请先在设置面板中选择保存路径或在全局配置中设置导出路径",
      position: "top",
    });
    rightDrawerOpen.value = true;
    return;
  }

  try {
    $q.loading.show({
      message: `正在保存 ${filesToDownload.length} 张图像，请稍候...`,
    });

    let successCount = 0;
    let errorCount = 0;

    // 检查是否在 Electron 环境中
    const isElectron = !!window.electron;

    for (const file of filesToDownload) {
      try {
        const fileName = file.name;
        // 获取最新处理后的图片
        if (processedImages.value[fileName]?.length) {
          const latestProcessedIndex =
            processedImages.value[fileName].length - 1;

          // 获取 blob 对象
          let blob;
          if (
            processedImages.value[fileName + "_blobs"]?.[latestProcessedIndex]
          ) {
            // 使用存储的 blob
            blob =
              processedImages.value[fileName + "_blobs"][latestProcessedIndex];
          } else {
            // 如果没有存储的 blob，从 URL 获取
            const response = await fetch(
              processedImages.value[fileName][latestProcessedIndex]
            );
            blob = await response.blob();
          }

          // 处理文件名（添加后缀以避免重名）
          const fileNameWithoutExt =
            fileName.substring(0, fileName.lastIndexOf(".")) || fileName;
          const fileExt =
            fileName.substring(fileName.lastIndexOf(".")) || ".png";
          const newFileName = `${fileNameWithoutExt}_processed${fileExt}`;

          if (isElectron) {
            try {
              // Electron 环境：使用 Node.js API 保存文件
              // 检查是否支持 save-file 方法
              if (typeof window.electron.ipcRenderer.invoke !== "function") {
                throw new Error("当前 Electron 版本不支持 invoke 方法");
              }

              // 使用更通用的 saveFile 方法名称
              const methodName = window.electron.ipcRenderer.hasHandler
                ? window.electron.ipcRenderer.hasHandler("save-file")
                  ? "save-file"
                  : "saveFile"
                : "saveFile";
              const fullPath = await window.electron.ipcRenderer.invoke(
                methodName,
                {
                  filePath: `${savePath.value}\\${newFileName}`,
                  blob: await blob.arrayBuffer(),
                }
              );

              if (fullPath) {
                successCount++;
              } else {
                throw new Error("保存文件失败，未返回路径");
              }
            } catch (electronError) {
              console.error(
                "Electron 保存失败，回退到浏览器下载:",
                electronError
              );
              // 回退到浏览器下载方式
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = newFileName;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
              successCount++;
            }
          } else {
            // 浏览器环境：使用下载链接
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = newFileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            successCount++;
          }
        }
      } catch (error) {
        console.error(`保存文件 ${file.name} 时出错:`, error);
        errorCount++;
      }
    }

    $q.loading.hide();

    // 显示结果通知
    if (successCount > 0) {
      $q.notify({
        type: "positive",
        message: `成功保存了 ${successCount} 张图像${
          errorCount > 0 ? `，${errorCount} 张保存失败` : ""
        }`,
        position: "top",
      });
    } else {
      $q.notify({
        type: "negative",
        message: "所有图像保存失败",
        position: "top",
      });
    }
  } catch (error) {
    $q.loading.hide();
    $q.notify({
      type: "negative",
      message: `保存图像失败: ${error.message}`,
      position: "top",
    });
    console.error("保存图像失败:", error);
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
    !selectedFile.value ||
    !processedImages.value[selectedFile.value.name]?.length
  )
    return;

  const fileName = selectedFile.value.name;
  const history = processedImages.value[fileName];

  // 移除最新的处理记录
  history.pop();

  // 如果没有处理记录了，清空历史
  if (history.length === 0) {
    delete processedImages.value[fileName];
  }

  $q.notify({
    type: "info",
    message: "已撤销最近的处理",
    position: "top",
  });
};
// 显示原图
const showOriginalImage = () => {
  if (
    selectedFile.value &&
    processedImages.value[selectedFile.value.name]?.length
  ) {
    showingOriginal.value = true;
  }
};
// 显示处理后的图片
const showProcessedImage = () => {
  showingOriginal.value = false;
};

// 检查是否需要显示历史记录上限警告
const checkHistoryLimit = (fileName) => {
  if (dontShowMaxHistoryWarning.value) return Promise.resolve(true);

  const historyLimit = configStore.config.advanced.imageHistoryLimit;
  const maxProcessedCount = historyLimit - 1; // 减去原图
  if (processedImages.value[fileName]?.length >= maxProcessedCount) {
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
  if (!currentMask.value || !currentMask.value.data || !maskFolderPath.value) {
    throw new Error("蒙版数据或蒙版文件夹路径不存在");
  }

  try {
    // 将蒙版数据转换为 Blob
    const response = await fetch(currentMask.value.data);
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
  selectedFiles,
  (newVal) => {
    if (filteredFiles.value.length > 0) {
      selectAll.value = newVal.length === filteredFiles.value.length;
    } else {
      selectAll.value = false;
    }
    appStateStore.updatePageState("image", {
      fileExplorer: {
        ...appStateStore.appState.imageState.fileExplorer,
        selectedFilesList: newVal,
      },
    });
  },
  { deep: true }
);
// 监听selectedFile变化，更新当前蒙版
watch(selectedFile, (newFile) => {
  if (newFile && newFile.type.startsWith("image/")) {
    currentMask.value = masks.value[newFile.name];
  } else {
    currentMask.value = null;
  }
});
// 监听文件变化，为新文件创建蒙版
watch(
  files,
  (newFiles) => {
    if (appStateStore.appState.isInitialized) {
      appStateStore.setInitialized(false);
    }
    // 更新当前页面的文件状态
    appStateStore.updatePageState("image", {
      fileExplorer: {
        ...appStateStore.appState.imageState.fileExplorer,
        selectedFiles: newFiles,
      },
    });
    newFiles.forEach((file) => {
      if (!masks.value[file.name] && file.type.startsWith("image/")) {
        // 为新文件创建空白蒙版
        masks.value[file.name] = {
          data: null, // 初始为空，将在ImageEditor中创建
          width: 0,
          height: 0,
        };
        // 检查文件大小，如果超过配置中的警告大小则显示警告
        const fileSizeMB = file.size / (1024 * 1024);
        const warningSize = configStore.config.advanced.imageWarningSize;
        if (fileSizeMB > warningSize) {
          $q.notify({
            type: "warning",
            message: `文件 "${file.name}" 大小为 ${fileSizeMB.toFixed(
              2
            )}MB，过大的文件可能导致绘制蒙版时卡顿。`,
            position: "top",
            timeout: 5000,
          });
        }
      }
    });
  },
  { deep: true }
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
// 监听蒙版变化，更新appState中的蒙版信息
watch(
  masks,
  (newMasks) => {
    Object.keys(newMasks).forEach((fileName) => {
      const file = files.value.find((f) => f.name === fileName);
      if (file && file.path && newMasks[fileName]) {
        appStateStore.updateFileMask("image", file.path, newMasks[fileName]);
      }
    });
  },
  { deep: true }
);

watchEffect(() => {
  if (!selectedFile.value && filteredFiles.value.length > 0) {
    selectedFile.value = filteredFiles.value[0];
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
onMounted(() => {
  // 监听配置更新事件
  const handleConfigUpdate = (event) => {
    const newConfig = event.detail.config;
    // 更新保存路径
    const exportPath = newConfig.fileManagement.exportPath;
    const imageFolderName = newConfig.fileManagement.imageFolderName;
    savePath.value =
      exportPath && imageFolderName ? `${exportPath}\\${imageFolderName}` : "";
  };

  window.addEventListener("config-updated", handleConfigUpdate);

  // 在 onUnmounted 中清理
  onUnmounted(() => {
    window.removeEventListener("config-updated", handleConfigUpdate);
  });
});
onMounted(async () => {
  try {
    // 加载配置
    await configStore.loadConfig();
  } catch (error) {
    console.error("配置加载失败:", error);
    // 配置加载失败时，保持默认的空字符串，用户可手动设置
  } finally {
    // 配置加载完成后，初始化保存路径
    const exportPath = configStore.config.fileManagement.downloadPath;
    const imageFolderName = configStore.config.fileManagement.imageFolderName;
    if (exportPath && imageFolderName) {
      savePath.value = `${exportPath}\\${imageFolderName}`;
    }
  }
  // 检查是否存在状态文件
  if (window.electron) {
    try {
      const hasState = await window.electron.ipcRenderer.invoke(
        "check-app-state-exists"
      );
      if (hasState) {
        // 询问用户是否加载上次的状态
        $q.dialog({
          title: "发现上次的工作状态",
          message: "检测到上次未完成的工作，是否恢复上次的状态？",
          cancel: {
            label: "重新开始",
            color: "negative",
          },
          ok: {
            label: "恢复状态",
            color: "primary",
          },
          persistent: true,
        })
          .onOk(async () => {
            // 用户选择恢复状态
            await loadPreviousState();
          })
          .onCancel(async () => {
            // 用户选择重新开始，清除状态
            await appStateStore.restart();
          });
      }
    } catch (error) {
      console.error("检查状态文件失败:", error);
    }
  }

  // 检测是否在 Electron 环境中
  isElectron.value = !!window.electron;

  // 如果在 Electron 环境中，获取资源路径
  if (isElectron.value && window.electron) {
    try {
      // 使用 IPC 从主进程获取资源路径
      if (window.electron.ipcRenderer && window.electron.ipcRenderer.invoke) {
        resourcesPath.value = await window.electron.ipcRenderer.invoke(
          "get-resources-path"
        );
      } else {
        // 备选路径
        resourcesPath.value = "./resources";
      }
    } catch (error) {
      console.error("获取资源路径失败:", error);
      resourcesPath.value = "./resources";
    }
  }
});

// 加载上次状态的函数
const loadPreviousState = async () => {
  try {
    const stateResult = await appStateStore.loadState();
    if (stateResult.success && !stateResult.noData) {
      // 恢复图像状态
      const imageState = appStateStore.appState.imageState;
      // 恢复文件状态 - 优先使用 selectedFilesList 中的路径信息
      if (
        imageState.fileExplorer.selectedFilesList &&
        imageState.fileExplorer.selectedFilesList.length > 0
      ) {
        try {
          // 解析 selectedFilesList（JSON字符串格式）
          const filesList =
            typeof imageState.fileExplorer.selectedFilesList === "string"
              ? JSON.parse(imageState.fileExplorer.selectedFilesList)
              : imageState.fileExplorer.selectedFilesList;

          // 提取所有文件路径
          const filePaths = filesList.map((item) => item.path).filter(Boolean);

          if (filePaths.length > 0) {
            // 使用 appStateStore 的 recreateFilesFromPaths 函数重新创建文件对象
            const missingFiles = [];
            const recreatedFiles = [];

            for (const filePath of filePaths) {
              try {
                const result = await window.electron.ipcRenderer.invoke(
                  "read-file",
                  filePath
                );

                if (result.success) {
                  // 创建新的File对象
                  const uint8Array = new Uint8Array(result.data.buffer);
                  const blob = new Blob([uint8Array], {
                    type: result.data.type,
                  });
                  const file = new File([blob], result.data.name, {
                    type: result.data.type,
                    lastModified: result.data.lastModified,
                  });

                  // 添加路径信息
                  Object.defineProperty(file, "path", {
                    value: filePath,
                    writable: false,
                  });

                  recreatedFiles.push(file);
                } else {
                  console.warn(`文件读取失败: ${result.error}`);
                  missingFiles.push(filePath);
                }
              } catch (error) {
                console.error(`读取文件失败 ${filePath}:`, error);
                missingFiles.push(filePath);
              }
            }

            // 设置重新创建的文件列表
            files.value = recreatedFiles;

            // 如果有文件丢失，显示提示
            if (missingFiles.length > 0) {
              $q.notify({
                type: "warning",
                message: `有 ${missingFiles.length} 个文件已不存在，已从列表中移除`,
                position: "top",
              });
            }
          }
        } catch (error) {
          console.error("解析 selectedFilesList 失败:", error);
          // 如果解析失败，尝试使用原有的 selectedFiles（作为备选方案）
          if (
            imageState.fileExplorer.selectedFiles &&
            imageState.fileExplorer.selectedFiles.length > 0
          ) {
            files.value = imageState.fileExplorer.selectedFiles;
          }
        }
      } else if (
        imageState.fileExplorer.selectedFiles &&
        imageState.fileExplorer.selectedFiles.length > 0
      ) {
        // 备选方案：使用原有的 selectedFiles
        files.value = imageState.fileExplorer.selectedFiles;
      }

      // 根据保存的 selectedFileName 恢复当前选中文件
      if (imageState.ui?.selectedFileName && files.value.length > 0) {
        const targetFile = files.value.find(
          (f) => f.name === imageState.ui.selectedFileName
        );
        selectedFile.value = targetFile || files.value[0];
      } else if (files.value.length > 0) {
        selectedFile.value = files.value[0];
      }

      // 恢复选中文件状态 - 根据文件名匹配
      if (
        imageState.fileExplorer.selectedFilesList &&
        imageState.fileExplorer.selectedFilesList.length > 0
      ) {
        try {
          const filesList =
            typeof imageState.fileExplorer.selectedFilesList === "string"
              ? JSON.parse(imageState.fileExplorer.selectedFilesList)
              : imageState.fileExplorer.selectedFilesList;

          // 根据文件名匹配选中的文件
          selectedFiles.value = files.value.filter((file) =>
            filesList.some((savedFile) => savedFile.name === file.name)
          );
        } catch (error) {
          console.error("恢复选中文件状态失败:", error);
          selectedFiles.value = [];
        }
      }
      // 恢复蒙版状态 - 修复路径和名称的映射问题
      if (imageState.fileExplorer.fileMasks) {
        // 清空现有蒙版
        masks.value = {};

        // 遍历保存的蒙版数据（按文件路径保存）
        Object.keys(imageState.fileExplorer.fileMasks).forEach((filePath) => {
          // 根据文件路径找到对应的文件
          const file = files.value.find((f) => f.path === filePath);
          if (file) {
            // 按文件名存储蒙版（因为组件中使用文件名作为key）
            masks.value[file.name] =
              imageState.fileExplorer.fileMasks[filePath];
          } else {
            // 如果找不到对应路径的文件，尝试按文件名匹配
            const fileName = filePath.split(/[\\/]/).pop(); // 提取文件名
            const fileByName = files.value.find((f) => f.name === fileName);
            if (fileByName) {
              masks.value[fileByName.name] =
                imageState.fileExplorer.fileMasks[filePath];
            }
          }
        });

        // 恢复当前蒙版
        if (selectedFile.value && masks.value[selectedFile.value.name]) {
          currentMask.value = masks.value[selectedFile.value.name];
        }
      }
    }
  } catch (error) {
    console.error("状态加载失败:", error);
    $q.notify({
      type: "negative",
      message: "状态恢复失败: " + error.message,
      position: "top",
    });
  }
};
// 在路由离开前保存当前页面状态
onBeforeRouteLeave(async (to, from, next) => {
  // 如果是初始化状态，直接允许切换，不显示提示框
  if (appStateStore.appState.isInitialized) {
    next();
    return;
  }
  // 如果当前有上传的文件，提醒用户过程图片会丢失
  if (files.value.length > 0) {
    // 检查是否有过程图片
    const hasProcessedImages = Object.keys(processedImages.value).some(
      (fileName) => processedImages.value[fileName]?.length > 0
    );

    if (hasProcessedImages) {
      const shouldContinue = await new Promise((resolve) => {
        $q.dialog({
          title: "切换页面提醒",
          message:
            "当前的工作状态保存只能保存原始图片和当前蒙版信息，过程图片在切换页面时会丢失，是否切换页面？",
          cancel: {
            label: "取消",
            color: "info",
          },
          ok: {
            color: "primary",
            label: "确认切换",
          },
          persistent: true,
        })
          .onOk(() => {
            resolve(true);
          })
          .onCancel(() => {
            resolve(false);
          });
      });

      if (!shouldContinue) {
        next(false); // 阻止路由切换
        return;
      }
    }
  }

  // 保存当前工作区状态
  const workspaceState = {
    canvasData: editorRef.value?.getCanvasData?.() || null,
    selection: editorRef.value?.getSelection?.() || null,
  };

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
    selectedFileName: selectedFile.value?.name || null,
  };

  // 更新页面状态 - 移除不需要的字段
  appStateStore.updatePageState("image", {
    workspace: workspaceState,
    ui: uiState,
    fileExplorer: {
      selectedFilesList: JSON.stringify(
        files.value.map((f) => ({ name: f.name, path: f.path }))
      ), // 只保存文件名和路径的映射
      fileMasks: Object.fromEntries(
        Object.entries(masks.value)
          .map(([fileName, mask]) => {
            const file = files.value.find((f) => f.name === fileName);
            return file?.path ? [file.path, mask] : null;
          })
          .filter(Boolean)
      ),
    },
  });

  // 保存状态
  await appStateStore.saveState();
  next(); // 允许路由切换
});
// 在组件卸载时清理资源
onUnmounted(() => {
  // 释放原始文件的URL
  Object.values(fileUrls.value).forEach((url) => {
    URL.revokeObjectURL(url);
  });

  // 释放处理后图片的URL
  Object.keys(processedImages.value).forEach((fileName) => {
    processedImages.value[fileName].forEach((url) => {
      URL.revokeObjectURL(url);
    });
  });

  // 清理 store 中的 URL
  store.cleanupUrls();
});
</script>
