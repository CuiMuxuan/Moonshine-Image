<template>
  <q-layout view="hHh LpR lFf">
    <q-header elevated class="bg-primary text-white" height-hint="98">
      <q-toolbar>
        <q-toolbar-title>
          <q-avatar>
            <moonshine-icon color="white" :size="24" />
          </q-avatar>
          Moonshine-Image
        </q-toolbar-title>

        <!-- GitHub 图标 -->
        <q-btn flat round dense class="q-mr-sm" @click="openGithubLink">
          <q-icon name="code" />
          <q-tooltip>GitHub 仓库</q-tooltip>
        </q-btn>

        <!-- 赞助按钮 -->
        <q-btn
          flat
          round
          dense
          icon="favorite"
          class="q-mr-sm"
          @click="showSponsorDialog = true"
        >
          <q-tooltip>支持作者</q-tooltip>
        </q-btn>

        <!-- 赞助对话框 -->
        <q-dialog v-model="showSponsorDialog" persistent>
          <q-card class="sponsor-card" style="width: 90%; max-width: 800px">
            <q-card-section class="row items-center q-pb-none">
              <div class="text-h6">感谢您的支持</div>
              <q-space />
              <q-btn icon="close" flat round dense v-close-popup />
            </q-card-section>

            <q-card-section>
              <div class="row justify-around q-mb-md">
                <div class="col-xs-12 col-sm-5 text-center q-pa-sm">
                  <p class="q-mb-sm">微信支付</p>
                  <q-img
                    :src="getImagePath('wxPay.png')"
                    style="width: 100%; max-width: 300px"
                    spinner-color="primary"
                    contain
                  />
                </div>
                <div class="col-xs-12 col-sm-5 text-center q-pa-sm">
                  <p class="q-mb-sm">支付宝</p>
                  <q-img
                    :src="getImagePath('Alipay.jpg')"
                    style="width: 100%; max-width: 300px"
                    spinner-color="primary"
                    contain
                  />
                </div>
              </div>

              <q-separator class="q-my-md" />

              <div class="text-center">
                <p>或者你也可以阅读作者写的免费小说</p>
                <q-btn
                  color="primary"
                  icon="menu_book"
                  label="阅读小说"
                  @click="openNovelLink"
                />
              </div>
            </q-card-section>
          </q-card>
        </q-dialog>

        <!-- 作者头像 -->
        <q-avatar class="cursor-pointer" @click="openBilibiliLink">
          <q-img :src="getImagePath('moonshine128x128.jpg')" :ratio="1" />
          <q-tooltip>作者B站</q-tooltip>
        </q-avatar>
      </q-toolbar>

      <q-btn-toggle
        v-model="currentModel"
        spread
        no-caps
        rounded
        unelevated
        toggle-color="deep-purple-2"
        color="primary"
        text-color="deep-purple-2"
        :toggle-text-color="'primary'"
        class="q-px-md q-py-sm"
        :options="[
          { label: '去除模型', value: 'remove' },
          { label: 'OCR文字识别', value: 'ocr' },
          { label: '修复模型', value: 'repair' },
        ]"
      />
    </q-header>

    <q-drawer show-if-above v-model="leftDrawerOpen" side="left" elevated>
      <file-list
        :files="files"
        :selected-file="selectedFile"
        :selected-files="selectedFiles"
        :file-urls="fileUrls"
        @update:selected-file="selectedFile = $event"
        @toggle-selection="toggleFileSelection"
        @remove-file="removeFile"
      />
    </q-drawer>

    <q-drawer show-if-above v-model="rightDrawerOpen" side="right" bordered>
      <div v-if="currentModel === 'remove'" class="q-pa-md">
        <div class="text-h6 q-mb-md flex items-center">
          <q-icon name="settings" class="q-mr-sm" />
          运行设置
        </div>
        <q-list>
          <!-- 作用范围 -->
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

          <!-- 全选开关 -->
          <q-item>
            <q-item-section>
              <q-toggle
                v-model="selectAll"
                label="全选文件"
                @update:model-value="handleSelectAll"
              />
            </q-item-section>
          </q-item>

          <!-- 删除选中文件 -->
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
          <!-- 当前蒙版作用于选中文件 -->
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

          <!-- 保存路径 -->
          <q-item>
            <q-item-section>
              <folder-selector v-model="savePath" label="保存路径" />
            </q-item-section>
          </q-item>
          <!-- 输入文件夹路径 -->
          <q-item v-if="actionScope.value === 'folder'">
            <q-item-section>
              <folder-selector v-model="folderPath" label="输入文件夹路径" />
            </q-item-section>
          </q-item>
          <!-- 蒙版文件夹路径 -->
          <q-item v-if="actionScope.value === 'folder'">
            <q-item-section>
              <folder-selector
                v-model="maskFolderPath"
                label="蒙版文件夹路径"
              />
            </q-item-section>
          </q-item>
          <!-- CUDA状态和开关 -->

          <q-item>
            <q-item-section>
              <cuda-status @cuda-status-changed="handleCudaStatusChanged" />
            </q-item-section>
          </q-item>
        </q-list>
      </div>

      <div v-else-if="currentModel === 'ocr'" class="q-pa-md">
        <div class="text-h6 q-mb-md">OCR 设置</div>
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
        </q-list>
      </div>

      <div v-else-if="currentModel === 'repair'" class="q-pa-md">
        <!-- 修复模型暂时为空 -->
      </div>
    </q-drawer>
    <!-- drawer content -->

    <q-page-container>
      <router-view
        :selected-file="selectedFile"
        :show-mask-tools="showMaskTools"
        :current-mask="currentMask"
        :file-url="selectedFile ? fileUrls[selectedFile.name] : null"
        @update:mask="updateMask"
      />
    </q-page-container>

    <q-footer bordered class="bg-grey-8 text-white">
      <div class="row no-wrap shadow-1">
        <q-toolbar class="col-4 bg-deep-purple-2">
          <q-btn
            flat
            round
            dense
            icon="folder_open"
            class="q-mr-sm text-primary"
            @click="toggleLeftDrawer"
          >
            <q-tooltip>文件目录</q-tooltip>
          </q-btn>

          <q-file
            ref="fileInput"
            v-model="files"
            label="选择文件"
            filled
            counter
            multiple
            append
            use-chips
            class="full-width"
            style="margin-top: 4px"
            accept=".png,.jpg,.jpeg,.webp"
            @rejected="onRejectedFiles"
          >
            <template v-slot:label>
              <span
                class="text-weight-bold"
                :class="files.length ? 'text-green-8' : 'text-deep-purple'"
                >{{ files.length ? "当前加载文件" : "点此选择文件" }}</span
              >
            </template>
            <template v-slot:selected>
              <q-chip
                v-if="selectedFile"
                class="q-ma-xs"
                color="primary"
                text-color="white"
              >
                <q-avatar>
                  <q-icon :name="getFileIcon(selectedFile)" />
                </q-avatar>

                {{ selectedFile.name }}
                <q-tooltip>
                  {{ selectedFile.name }} ({{
                    (selectedFile.size / 1024).toFixed(2)
                  }}
                  KB)
                </q-tooltip>
              </q-chip>
            </template>
            <template v-slot:hint> Field hint </template>
            <template v-slot:append>
              <q-btn
                round
                dense
                flat
                icon="add"
                @click.stop="fileInput.pickFiles()"
              />
            </template>
          </q-file>
        </q-toolbar>
        <q-toolbar class="col-8 bg-deep-purple-2 text-white">
          <q-space />
          <div class="row full-width justify-end">
            <!-- 工具栏按钮组 -->
            <div class="col-12 row justify-around items-center">
              <!-- 工具栏隐显按钮 -->
              <q-btn
                v-if="currentModel === 'remove'"
                flat
                :icon="showMaskTools ? 'edit_off' : 'edit'"
                :color="showMaskTools ? 'primary' : 'white'"
                :label="
                  $q.screen.gt.sm
                    ? showMaskTools
                      ? '停止绘制'
                      : '开始绘制'
                    : ''
                "
                @click="showMaskTools = !showMaskTools"
                class="col-auto"
                :disable="!selectedFile"
              >
                <q-tooltip v-if="!$q.screen.gt.sm">{{
                  showMaskTools ? "隐藏绘制工具" : "显示绘制工具"
                }}</q-tooltip>
              </q-btn>

              <!-- 对比原图按钮 -->
              <q-btn
                flat
                icon="compare"
                color="primary"
                :label="$q.screen.gt.sm ? '对比原图' : ''"
                class="col-auto"
                :disable="
                  !selectedFile || !processedImages[selectedFile.name]?.length
                "
                @mousedown="showOriginalImage"
                @mouseup="showProcessedImage"
                @mouseleave="showProcessedImage"
              >
                <q-tooltip v-if="!$q.screen.gt.sm">对比原图</q-tooltip>
              </q-btn>

              <!-- 撤销处理按钮 -->
              <q-btn
                flat
                icon="undo"
                color="primary"
                :label="$q.screen.gt.sm ? '撤销处理' : ''"
                class="col-auto"
                :disable="
                  !selectedFile || !processedImages[selectedFile.name]?.length
                "
                @click="undoProcessing"
              >
                <q-tooltip v-if="!$q.screen.gt.sm">撤销处理</q-tooltip>
              </q-btn>

              <!-- 运行按钮 -->
              <q-btn
                flat
                icon="play_arrow"
                color="primary"
                :label="$q.screen.gt.sm ? '运行' : ''"
                class="col-auto"
                :disable="!selectedFile"
                @click="runCurrentModel"
              >
                <q-tooltip v-if="!$q.screen.gt.sm">运行</q-tooltip>
              </q-btn>

              <!-- 下载按钮 -->
              <q-btn
                flat
                icon="download"
                color="primary"
                :label="$q.screen.gt.sm ? '下载' : ''"
                class="col-auto"
                :disable="!selectedFile"
                @click="downloadProcessedImages"
              >
                <q-tooltip v-if="!$q.screen.gt.sm">下载</q-tooltip>
              </q-btn>

              <!-- 右侧栏显示/隐藏按钮 -->
              <q-btn
                flat
                icon="more_vert"
                color="primary"
                class="col-auto"
                @click="toggleRightDrawer"
              >
                <q-tooltip>设置面板</q-tooltip>
              </q-btn>
            </div>
          </div>
        </q-toolbar>
      </div>
    </q-footer>
  </q-layout>
</template>

<script setup>
import { ref, computed, watchEffect, onUnmounted, watch, onMounted } from "vue";
import { useQuasar } from "quasar";
import MoonshineIcon from "src/components/MoonshineIcon.vue";
import FileList from "src/components/FileList.vue";
import FolderSelector from "src/components/FolderSelector.vue";
import CudaStatus from "src/components/CudaStatus.vue";
import InpaintService from "src/services/InpaintService";

const $q = useQuasar();
const leftDrawerOpen = ref(false);
const rightDrawerOpen = ref(false);
const files = ref([]);
const selectedFile = ref(null);
const selectedFiles = ref([]);
const fileInput = ref(null);
const currentModel = ref("remove"); // 默认选中去除模型
const ocrLang = ref("中文");
const autoLayout = ref(true);
const showMaskTools = ref(true);
const actionScope = ref({ label: "仅当前文件", value: "current" });
const selectAll = ref(false);
const savePath = ref("");
const cudaAvailable = ref(false); // 默认为不可用，等待检测结果
const cudaInfo = ref(null);
const masks = ref({});
const currentMask = ref(null);
const processedImages = ref({}); // 存储处理后的图片历史记录
const showingOriginal = ref(false); // 是否正在显示原图
const dontShowMaxHistoryWarning = ref(false); // 是否不再显示历史记录上限警告
const folderPath = ref("");
const maskFolderPath = ref("");
import { useEditorStore } from "../stores/editor";
const store = useEditorStore();
const isElectron = ref(false);
const resourcesPath = ref("");
const showSponsorDialog = ref(false);

const getFileIcon = (file) => {
  const type = file.type?.split("/")[0] || "";
  return (
    {
      image: "photo",
      video: "movie",
      audio: "music_note",
      text: "description",
      application: "insert_drive_file",
    }[type] || "insert_drive_file"
  );
};
// 切换文件选择
const toggleFileSelection = (file) => {
  const index = selectedFiles.value.findIndex((f) => f.name === file.name);
  if (index === -1) {
    selectedFiles.value.push(file);
  } else {
    selectedFiles.value.splice(index, 1);
  }
};
const filteredFiles = computed(() =>
  files.value.filter((f) => f.type.startsWith("image/"))
);

// 处理全选
const handleSelectAll = (val) => {
  if (val) {
    // 全选所有文件
    selectedFiles.value = [...filteredFiles.value];
  } else {
    // 取消全选
    selectedFiles.value = [];
  }
};
const fileUrls = computed(() => {
  const urls = {};
  filteredFiles.value.forEach((file) => {
    if (!urls[file.name]) {
      // 如果有处理后的图片且不是显示原图模式，使用处理后的图片
      if (!showingOriginal.value && processedImages.value[file.name]?.length) {
        const history = processedImages.value[file.name];
        urls[file.name] = history[history.length - 1];
      } else {
        // 否则使用原图
        urls[file.name] = URL.createObjectURL(file);
      }
    }
  });
  return urls;
});

// 更新蒙版数据
const updateMask = (fileName, maskData) => {
  if (masks.value[fileName]) {
    masks.value[fileName] = maskData;
    // 如果当前选中的文件就是被更新的文件，直接更新currentMask
    if (selectedFile.value && selectedFile.value.name === fileName) {
      currentMask.value = maskData;
    }
  }
};

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

// 添加抽屉切换方法
const toggleLeftDrawer = () => {
  leftDrawerOpen.value = !leftDrawerOpen.value;
};

const toggleRightDrawer = () => {
  rightDrawerOpen.value = !rightDrawerOpen.value;
};
// 运行当前模型
const runCurrentModel = () => {
  if (!selectedFile.value) return;

  switch (currentModel.value) {
    case "remove":
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

          // 初始化 blob 存储数组（如果不存在）
          if (!processedImages.value[fileName + "_blobs"]) {
            processedImages.value[fileName + "_blobs"] = [];
          }
          // 如果历史记录达到上限，删除最早的非原图记录
          if (processedImages.value[fileName].length >= 4) {
            // 4+原图=5个状态
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

    // 隐藏加载状态
    $q.loading.hide();
  } catch (error) {
    // 隐藏加载状态
    try {
      $q.loading.hide();
    } catch (e) {
      console.error("无法隐藏加载状态:", e);
    }

    // 显示错误通知
    $q.notify({
      type: "negative",
      message: `图像处理失败: ${error.message}`,
      position: "top",
    });
    console.error("图像处理失败:", error);
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

      $q.loading.hide();
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
    $q.loading.hide();
    $q.notify({
      type: "negative",
      message: `处理文件夹失败: ${error.message}`,
      position: "top",
    });
    console.error("处理文件夹失败:", error);
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
      message: "请先在设置面板中选择保存路径",
      position: "top",
    });
    // 自动打开右侧设置面板
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

  if (processedImages.value[fileName]?.length >= 4) {
    // 4+原图=5个状态
    return new Promise((resolve) => {
      $q.dialog({
        title: "历史记录上限提醒",
        message: "该图片已有5个处理记录，继续处理将删除最早的非原图处理记录。",
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

// 打开B站链接
const openBilibiliLink = () => {
  const url = "https://space.bilibili.com/589465087";
  openExternalLink(url);
};

// 打开小说链接
const openNovelLink = () => {
  const url = "https://fanqienovel.com/page/7458971942796659774";
  openExternalLink(url);
};
// 打开GitHub链接
const openGithubLink = () => {
  const url = "https://github.com/CuiMuxuan/Moonshine-Image";
  openExternalLink(url);
};

// 通用打开外部链接方法
const openExternalLink = (url) => {
  try {
    // 检查是否在Electron环境
    if (window.electron) {
      // 尝试使用不同的方法打开链接
      if (window.electron.openExternal) {
        // 直接使用预定义的方法
        window.electron.openExternal(url);
      } else if (
        window.electron.ipcRenderer &&
        window.electron.ipcRenderer.invoke
      ) {
        // 使用 invoke 方法
        window.electron.ipcRenderer.invoke("open-external-link", url);
      } else if (
        window.electron.ipcRenderer &&
        window.electron.ipcRenderer.sendSync
      ) {
        // 使用 sendSync 方法
        window.electron.ipcRenderer.sendSync("open-external-link", url);
      } else {
        // 回退到浏览器方式
        window.open(url, "_blank");
      }
    } else {
      // 浏览器环境，打开新标签页
      window.open(url, "_blank");
    }
  } catch (error) {
    console.error("打开外部链接失败:", error);
    // 出错时回退到浏览器方式
    try {
      window.open(url, "_blank");
    } catch (e) {
      console.error("无法打开链接:", e);
    }
  }
};
// 获取图片路径的函数
const getImagePath = (imageName) => {
  if (isElectron.value && process.env.NODE_ENV === "production") {
    // 生产环境 - Electron
    // 使用绝对路径，确保能找到资源
    if (resourcesPath.value) {
      return `${resourcesPath.value}/public/images/${imageName}`;
    } else {
      // 备选路径
      return `./resources/public/images/${imageName}`;
    }
  } else {
    // 开发环境或浏览器环境
    return `/images/${imageName}`;
  }
};
// 监听selectedFiles变化，更新selectAll状态
watch(selectedFiles, (newVal) => {
  if (filteredFiles.value.length > 0) {
    selectAll.value = newVal.length === filteredFiles.value.length;
  } else {
    selectAll.value = false;
  }
});
// 监听selectedFile变化，更新当前蒙版
watch(selectedFile, (newFile) => {
  if (newFile && newFile.type.startsWith("image/")) {
    currentMask.value = masks.value[newFile.name];
  } else {
    currentMask.value = null;
  }
});
// 监听文件变化，为新文件创建蒙版
watch(files, (newFiles) => {
  newFiles.forEach((file) => {
    if (!masks.value[file.name] && file.type.startsWith("image/")) {
      // 为新文件创建空白蒙版
      masks.value[file.name] = {
        data: null, // 初始为空，将在ImageEditor中创建
        width: 0,
        height: 0,
      };
      // 检查文件大小，如果超过2MB则显示警告
      const fileSizeMB = file.size / (1024 * 1024);
      if (fileSizeMB > 2) {
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
});
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
watchEffect(() => {
  if (!selectedFile.value && filteredFiles.value.length > 0) {
    selectedFile.value = filteredFiles.value[0];
  }
});
const onRejectedFiles = (rejectedEntries) => {
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

onMounted(async () => {
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

<style scoped>
/* 添加自定义间距 */
.q-item {
  margin: 4px 0;
  border-radius: 4px;
}
/* 赞助卡片样式 */
.sponsor-card {
  border-radius: 12px;
  transition: all 0.3s ease;
}

.sponsor-card .q-img {
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
  transition: transform 0.3s ease;
}

.sponsor-card .q-img:hover {
  transform: scale(1.05);
}

@media (max-width: 599px) {
  .sponsor-card {
    width: 95%;
  }
}
</style>
