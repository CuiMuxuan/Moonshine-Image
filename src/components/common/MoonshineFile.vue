<template>
  <div class="moonshine-file-wrapper">
    <q-dialog v-model="showUploadProgress" persistent>
      <q-card style="min-width: 400px">
        <q-card-section>
          <div class="text-h6">文件加载进度</div>
        </q-card-section>

        <q-card-section>
          <div class="q-mb-md">
            <div class="text-subtitle2">{{ uploadStatus.currentFile }}</div>
            <q-linear-progress :value="uploadStatus.progress" color="primary" size="20px" class="q-mt-sm">
              <div class="absolute-full flex flex-center">
                <q-badge color="white" text-color="primary" :label="`${Math.round((uploadStatus.progress || 0) * 100)}%`" />
              </div>
            </q-linear-progress>
          </div>
          <div class="text-caption text-grey-7">{{ uploadStatus.details }}</div>
        </q-card-section>

        <q-card-actions align="right">
          <q-btn flat color="negative" label="取消" :disable="!canCancelUpload" @click="cancelUpload" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <div class="file-selector-container">
      <q-btn
        :label="$q.screen.gt.xs ? label : ''"
        :icon="icon"
        :color="color"
        :disable="disable"
        @click="selectFiles"
        class="file-select-btn row"
        :class="{ 'icon-only': $q.screen.xs }"
        unelevated
        no-caps
      >
        <q-tooltip v-if="tooltip" class="bg-primary text-white">{{ tooltip }}</q-tooltip>
      </q-btn>

      <div
        v-if="fileManagerStore.files.length > 0"
        ref="fileIndicatorRef"
        class="file-indicator"
        @mouseenter="handleMouseEnter"
        @mouseleave="handleMouseLeave"
      >
        <q-btn flat round dense icon="expand_less" color="primary" class="file-count-btn">
          <q-badge color="negative" floating :label="fileManagerStore.files.length" rounded />
        </q-btn>

        <teleport to="body">
          <q-card
            v-show="showFileList && canShowFloatingList"
            class="file-list-popup"
            :class="{ 'file-list-popup--dark': $q.dark.isActive }"
            :style="popupStyle"
            @mouseenter="handleMouseEnter"
            @mouseleave="handleMouseLeave"
            bordered
            flat
          >
            <q-card-section class="q-pa-xs">
              <div class="text-subtitle2 text-primary q-mb-xs q-px-sm">
                已加载文件（{{ fileManagerStore.files.length }}）
              </div>
              <q-separator class="q-mb-xs" />
              <q-virtual-scroll
                :items="fileManagerStore.files"
                :virtual-scroll-item-size="54"
                :style="scrollAreaStyle"
                class="file-list-container q-pa-none"
                type="list"
                v-slot="{ item: file }"
              >
                  <q-item
                    :key="file.id"
                    class="file-item q-pa-xs"
                    clickable
                    v-ripple
                    :class="{ 'file-item-active': file.id === fileManagerStore.currentFileId }"
                    @click="fileManagerStore.setCurrentFile(file.id)"
                  >
                    <q-item-section avatar>
                      <q-avatar size="28px" color="primary" text-color="white">
                        <q-icon :name="getFileIcon(file)" />
                      </q-avatar>
                    </q-item-section>

                    <q-item-section>
                      <q-item-label class="text-caption ellipsis">{{ file.name }}</q-item-label>
                      <q-item-label caption>
                        历史记录：{{ file.history.length }}
                        <span v-if="file.mask" class="q-ml-xs">已设置蒙版</span>
                      </q-item-label>
                    </q-item-section>

                    <q-item-section side>
                      <q-btn flat round dense size="sm" icon="close" color="negative" @click.stop="removeFile(file.id)" />
                    </q-item-section>
                  </q-item>
              </q-virtual-scroll>
            </q-card-section>
          </q-card>
        </teleport>
      </div>
    </div>

    <input ref="fileInput" type="file" :accept="accept" :multiple="multiple" style="display: none" @change="handleFileChange" />
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useQuasar } from "quasar";
import { useFileManagerStore } from "src/stores/fileManager";

const $q = useQuasar();
const fileManagerStore = useFileManagerStore();

const props = defineProps({
  modelValue: {
    type: Array,
    default: () => [],
  },
  accept: {
    type: String,
    default: "image/*",
  },
  multiple: {
    type: Boolean,
    default: true,
  },
  label: {
    type: String,
    default: "选择文件",
  },
  icon: {
    type: String,
    default: "upload_file",
  },
  color: {
    type: String,
    default: "primary",
  },
  disable: {
    type: Boolean,
    default: false,
  },
  tooltip: {
    type: String,
    default: "",
  },
});

const emit = defineEmits(["update:modelValue", "file-added", "file-removed"]);

const fileInput = ref(null);
const showFileList = ref(false);
const fileIndicatorRef = ref(null);
const viewportWidth = ref(window.innerWidth);
const viewportHeight = ref(window.innerHeight);
const showUploadProgress = ref(false);
const canCancelUpload = ref(true);
const uploadStatus = ref({
  currentFile: "",
  progress: 0,
  details: "",
});

const POPUP_MARGIN = 12;
const POPUP_MAX_WIDTH = 560;
const POPUP_MIN_WIDTH = 300;
const POPUP_MIN_SCREEN_WIDTH = 560;
const POPUP_MIN_SCREEN_HEIGHT = 420;

let hideTimeout = null;

const canShowFloatingList = computed(
  () =>
    viewportWidth.value >= POPUP_MIN_SCREEN_WIDTH &&
    viewportHeight.value >= POPUP_MIN_SCREEN_HEIGHT
);

const popupWidth = computed(() => {
  const available = Math.max(0, viewportWidth.value - POPUP_MARGIN * 2);
  const minWidth = Math.min(POPUP_MIN_WIDTH, available);
  return Math.max(minWidth, Math.min(POPUP_MAX_WIDTH, available));
});

const popupMaxHeight = computed(() =>
  Math.max(160, Math.min(360, Math.floor(viewportHeight.value * 0.55)))
);

const popupEstimatedHeight = computed(() => {
  const listHeight = Math.min(fileManagerStore.files.length * 60, popupMaxHeight.value);
  return Math.min(listHeight + 64, viewportHeight.value - POPUP_MARGIN * 2);
});

const popupStyle = computed(() => {
  const width = popupWidth.value;
  const height = popupEstimatedHeight.value;
  const rect = fileIndicatorRef.value?.getBoundingClientRect();

  if (!rect) {
    return {
      width: `${width}px`,
      minWidth: `${Math.min(POPUP_MIN_WIDTH, width)}px`,
      left: `${POPUP_MARGIN}px`,
      top: `${POPUP_MARGIN}px`,
    };
  }

  const left = Math.max(
    POPUP_MARGIN,
    Math.min(rect.right - width, viewportWidth.value - width - POPUP_MARGIN)
  );
  const rawTop = rect.top >= height + POPUP_MARGIN ? rect.top - height - 8 : rect.bottom + 8;
  const top = Math.max(
    POPUP_MARGIN,
    Math.min(rawTop, viewportHeight.value - height - POPUP_MARGIN)
  );

  return {
    width: `${width}px`,
    minWidth: `${Math.min(POPUP_MIN_WIDTH, width)}px`,
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
  };
});

const scrollAreaStyle = computed(() => {
  const height = Math.min(fileManagerStore.files.length * 60, popupMaxHeight.value);
  return `height: ${height}px; max-height: ${popupMaxHeight.value}px;`;
});

const updateViewport = () => {
  viewportWidth.value = window.innerWidth;
  viewportHeight.value = window.innerHeight;
};

const syncModelValue = () => {
  emit(
    "update:modelValue",
    fileManagerStore.files.map((file) => file.originalFile).filter(Boolean)
  );
};

const getFileFilters = () => {
  if (props.accept === "*" || !props.accept) {
    return [];
  }

  const extensions = props.accept
    .split(",")
    .map((item) => item.trim().replace(".", ""))
    .filter(Boolean);

  return extensions.length > 0 ? [{ name: "支持的文件", extensions }] : [];
};

const getFileIcon = (file) => {
  const type = file.type?.split("/")[0] || "";
  return {
    image: "photo",
    video: "movie",
    audio: "music_note",
    text: "description",
    application: "insert_drive_file",
  }[type] || "insert_drive_file";
};

const normalizePathKey = (filePath = "") =>
  String(filePath || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();

const waitForUiYield = () =>
  new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });

const normalizeStatsDescriptor = (entry = {}, fallbackPath = "") => {
  const stats = entry.data || {};
  const filePath = stats.path || entry.normalizedPath || entry.path || fallbackPath;
  return {
    name: stats.name || filePath.split(/[\\/]/).pop() || "unknown",
    size: Number(stats.size || 0),
    type: stats.type || "",
    lastModified: Number(stats.lastModified || Date.now()),
    path: filePath,
    normalizedPath: stats.normalizedPath || entry.normalizedPath || filePath,
  };
};

const buildPathDescriptor = async (filePath) => {
  const result = await window.electron.ipcRenderer.invoke("get-file-stats", filePath);
  if (!result?.success) {
    throw new Error(result?.error || `无法读取文件信息：${filePath}`);
  }

  const stats = result.data || {};
  return {
    name: stats.name || filePath.split(/[\\/]/).pop() || "unknown",
    size: Number(stats.size || 0),
    type: stats.type || "",
    lastModified: Number(stats.lastModified || Date.now()),
    path: filePath,
  };
};

const buildPathDescriptors = async (filePaths) => {
  if (window.electron?.ipcRenderer?.invoke) {
    const result = await window.electron.ipcRenderer.invoke("get-files-stats", filePaths);
    if (result?.success && Array.isArray(result.data)) {
      return result.data
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry?.success)
        .map(({ entry, index }) => normalizeStatsDescriptor(entry, filePaths[index]));
    }
  }

  const descriptors = [];
  for (const filePath of filePaths) {
    descriptors.push(await buildPathDescriptor(filePath));
  }
  return descriptors;
};

const startProgress = () => {
  showUploadProgress.value = true;
  canCancelUpload.value = true;
};

const finishProgress = () => {
  window.setTimeout(() => {
    showUploadProgress.value = false;
  }, 600);
};

const selectFiles = async () => {
  if (window.electron?.ipcRenderer?.invoke) {
    try {
      const result = await window.electron.ipcRenderer.invoke("select-file", {
        title: "选择文件",
        filters: getFileFilters(),
        properties: props.multiple ? ["openFile", "multiSelections"] : ["openFile"],
      });

      if (!result.canceled && result.filePaths.length > 0) {
        await loadFilesFromPathsOptimized(result.filePaths);
      }
    } catch (error) {
      $q.notify({
        type: "negative",
        message: `文件选择失败：${error.message}`,
        position: "top",
      });
    }
    return;
  }

  fileInput.value?.click();
};

const handleFileChange = async (event) => {
  const files = Array.from(event.target.files || []);
  if (files.length > 0) {
    await processBrowserFiles(files);
  }
  event.target.value = "";
};

const processBrowserFiles = async (files) => {
  startProgress();
  let processedCount = 0;

  try {
    for (let index = 0; index < files.length; index += 1) {
      if (!canCancelUpload.value) break;

      const file = files[index];
      uploadStatus.value = {
        currentFile: file.name || `文件 ${index + 1}`,
        progress: processedCount / files.length,
        details: `正在处理文件 ${index + 1} / ${files.length}`,
      };

      const fileData = await fileManagerStore.addFile(file, (progress) => {
        if (!canCancelUpload.value) return;
        uploadStatus.value = {
          currentFile: file.name || `文件 ${index + 1}`,
          progress: (processedCount + (progress || 0)) / files.length,
          details: `正在读取 ${file.name}（${Math.round((progress || 0) * 100)}%）`,
        };
      });

      processedCount += 1;
      emit("file-added", fileData);
    }

    syncModelValue();

    if (processedCount > 0) {
      uploadStatus.value = {
        currentFile: "处理完成",
        progress: 1,
        details: `成功加载 ${processedCount} 个文件`,
      };
      $q.notify({
        type: "positive",
        message: `成功添加 ${processedCount} 个文件`,
        position: "top",
      });
    }
  } catch (error) {
    $q.notify({
      type: "negative",
      message: `文件处理失败：${error.message}`,
      position: "top",
    });
  } finally {
    finishProgress();
  }
};

const loadFilesFromPathsOptimized = async (filePaths) => {
  startProgress();
  let processedCount = 0;
  let skippedCount = 0;

  try {
    const existingPathKeys = new Set(
      fileManagerStore.files
        .map((file) => normalizePathKey(file.originalFile?.path || file.image?.data || ""))
        .filter(Boolean)
    );
    const selectedPathKeys = new Set();
    const uniquePaths = [];

    for (const filePath of filePaths) {
      const pathKey = normalizePathKey(filePath);
      if (!pathKey || existingPathKeys.has(pathKey) || selectedPathKeys.has(pathKey)) {
        skippedCount += 1;
        continue;
      }
      selectedPathKeys.add(pathKey);
      uniquePaths.push(filePath);
    }

    if (uniquePaths.length === 0) {
      uploadStatus.value = {
        currentFile: "没有新增文件",
        progress: 1,
        details: skippedCount > 0 ? `已跳过 ${skippedCount} 个重复文件` : "没有可载入的文件",
      };
      return;
    }

    uploadStatus.value = {
      currentFile: "正在读取文件信息",
      progress: 0,
      details: `正在批量读取 ${uniquePaths.length} 个文件的元数据`,
    };

    const descriptors = await buildPathDescriptors(uniquePaths);
    const total = descriptors.length;
    const chunkSize = Math.max(1, Math.floor(total / 100));

    for (let index = 0; index < total; index += chunkSize) {
      if (!canCancelUpload.value) break;

      const chunk = descriptors.slice(index, index + chunkSize);
      const createdFiles = fileManagerStore.addPathFiles(chunk);
      processedCount += createdFiles.length;
      createdFiles.forEach((fileData) => emit("file-added", fileData));

      const completed = Math.min(index + chunk.length, total);
      uploadStatus.value = {
        currentFile: chunk[chunk.length - 1]?.name || `文件 ${completed}`,
        progress: completed / Math.max(1, total),
        details: `正在建立文件索引 ${completed} / ${total}`,
      };
      await waitForUiYield();
    }

    syncModelValue();

    if (processedCount > 0) {
      uploadStatus.value = {
        currentFile: canCancelUpload.value ? "加载完成" : "已取消加载",
        progress: 1,
        details: `成功加载 ${processedCount} 个文件${skippedCount ? `，跳过 ${skippedCount} 个重复文件` : ""}`,
      };
      $q.notify({
        type: canCancelUpload.value ? "positive" : "info",
        message: canCancelUpload.value
          ? `成功加载 ${processedCount} 个文件`
          : `已取消加载，保留 ${processedCount} 个已加载文件`,
        position: "top",
      });
    }
  } catch (error) {
    $q.notify({
      type: "negative",
      message: `文件加载失败：${error.message}`,
      position: "top",
    });
  } finally {
    finishProgress();
  }
};

const removeFile = (fileId) => {
  const file = fileManagerStore.files.find((item) => item.id === fileId);
  if (!file) return;

  fileManagerStore.removeFile(fileId);
  emit("file-removed", file);
  syncModelValue();

  $q.notify({
    type: "info",
    message: `已移除文件 ${file.name}`,
    position: "top",
  });
};

const cancelUpload = () => {
  canCancelUpload.value = false;
  showUploadProgress.value = false;
  $q.notify({
    type: "info",
    message: "已取消文件加载",
    position: "top",
  });
};

const handleMouseLeave = () => {
  hideTimeout = window.setTimeout(() => {
    showFileList.value = false;
  }, 250);
};

const handleMouseEnter = () => {
  if (hideTimeout) {
    window.clearTimeout(hideTimeout);
    hideTimeout = null;
  }

  if (!canShowFloatingList.value) {
    showFileList.value = false;
    return;
  }

  showFileList.value = true;
  nextTick(() => {
    updateViewport();
  });
};

watch(canShowFloatingList, (canShow) => {
  if (!canShow) {
    showFileList.value = false;
  }
});

watch(
  () => props.modelValue,
  () => {
    fileManagerStore.initProcessingConfig();
  }
);

onMounted(() => {
  fileManagerStore.initProcessingConfig();
  updateViewport();
  window.addEventListener("resize", updateViewport);
});

onUnmounted(() => {
  window.removeEventListener("resize", updateViewport);
  if (hideTimeout) {
    window.clearTimeout(hideTimeout);
  }
});

defineExpose({
  selectFiles,
  removeFile,
});
</script>

<style scoped>
.moonshine-file-wrapper {
  width: 100%;
}

.file-selector-container {
  display: flex;
  align-items: center;
  gap: 8px;
}

.file-select-btn {
  flex: 1;
  min-width: 44px;
  transition: all 0.3s ease;
}

.file-select-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
}

.icon-only {
  min-width: 44px;
  max-width: 44px;
  padding: 8px;
}

.file-indicator {
  position: relative;
}

.file-count-btn {
  min-width: 40px;
}

.file-list-popup {
  position: fixed;
  z-index: 3200;
  border-radius: 8px;
  border: 1px solid rgba(59, 130, 246, 0.16);
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.18);
  backdrop-filter: blur(10px);
  background: rgba(255, 255, 255, 0.96);
}

.file-list-container {
  min-height: 10vh;
  max-height: 50vh;
}

.file-item {
  border-radius: 8px;
  margin: 2px 4px;
}

.file-item-active {
  background: rgba(59, 130, 246, 0.1);
}

:global(body.body--dark) .file-list-popup {
  border-color: rgba(148, 163, 184, 0.24);
  background: rgba(24, 24, 27, 0.98);
  color: rgba(244, 244, 245, 0.94);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.42);
}

:global(.file-list-popup--dark) {
  border-color: rgba(148, 163, 184, 0.24) !important;
  background: rgba(24, 24, 27, 0.98) !important;
  color: rgba(244, 244, 245, 0.94) !important;
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.42);
}

:global(body.body--dark) .file-list-popup :deep(.text-primary) {
  color: #c4b5fd !important;
}

:global(.file-list-popup--dark .text-primary) {
  color: #c4b5fd !important;
}

:global(body.body--dark) .file-list-popup :deep(.q-item__label--caption) {
  color: rgba(212, 212, 216, 0.72);
}

:global(.file-list-popup--dark .q-item__label--caption) {
  color: rgba(212, 212, 216, 0.72) !important;
}

:global(body.body--dark) .file-item:hover {
  background: rgba(119, 88, 196, 0.18);
}

:global(.file-list-popup--dark .file-item:hover) {
  background: rgba(119, 88, 196, 0.18);
}

:global(body.body--dark) .file-item-active {
  background: rgba(119, 88, 196, 0.26);
}

:global(.file-list-popup--dark .file-item-active) {
  background: rgba(119, 88, 196, 0.26);
}

.ellipsis {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 220px;
}

@media (max-width: 599px) {
  .file-select-btn {
    min-width: 44px;
    max-width: 44px;
    padding: 8px;
  }
}
</style>
