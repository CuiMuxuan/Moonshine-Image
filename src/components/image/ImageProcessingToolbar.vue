<template>
  <div
    class="image-processing-toolbar"
    :class="$q.dark.isActive ? 'bg-primary text-secondary' : 'bg-secondary text-primary'"
  >
    <div class="row no-wrap shadow-1">
      <q-toolbar
        class="toolbar-file-area"
        :class="$q.dark.isActive ? 'bg-primary' : 'bg-secondary'"
      >
        <q-btn
          flat
          round
          dense
          icon="folder_open"
          class="q-mr-sm text-primary"
          @click="$emit('toggle-file-explorer')"
        >
          <q-tooltip>文件目录</q-tooltip>
        </q-btn>

        <moonshine-file
          ref="fileInput"
          v-model="localFiles"
          :accept="fileAccept"
          :multiple="true"
          label="选择文件"
          list-mode="selection"
          color="primary"
          class="full-width"
          @rejected="$emit('rejected-files', $event)"
          @update:model-value="handleFilesUpdate"
        />
      </q-toolbar>

      <q-toolbar
        class="toolbar-actions"
        :class="$q.dark.isActive ? 'bg-primary text-secondary' : 'bg-secondary text-primary'"
      >
        <div class="toolbar-button-row">
          <span class="toolbar-button-wrap">
            <q-btn
              flat
              :icon="showMaskTools ? 'edit_off' : 'edit'"
              :color="showMaskTools ? 'primary' : 'white'"
              :label="$q.screen.gt.sm ? maskToggleLabel : ''"
              class="full-width"
              :disable="maskToggleDisabled"
              @click="$emit('toggle-mask-tools')"
            />
            <q-tooltip>{{ maskToggleTooltip }}</q-tooltip>
          </span>

          <span class="toolbar-button-wrap">
            <q-btn
              flat
              icon="compare"
              color="primary"
              :label="$q.screen.gt.sm ? '对比原图' : ''"
              class="full-width"
              :disable="compareDisabled"
              @pointerdown="$emit('show-original')"
              @pointerup="$emit('show-processed')"
              @pointerleave="$emit('show-processed')"
              @pointercancel="$emit('show-processed')"
            />
            <q-tooltip>{{ compareTooltip }}</q-tooltip>
          </span>

          <span class="toolbar-button-wrap">
            <q-btn
              flat
              icon="undo"
              color="primary"
              :label="$q.screen.gt.sm ? '撤销处理' : ''"
              class="full-width"
              :disable="undoDisabled"
              @click="$emit('undo-processing')"
            />
            <q-tooltip>{{ undoTooltip }}</q-tooltip>
          </span>

          <span class="toolbar-button-wrap" @click="handleRunWrapperClick">
            <q-btn
              flat
              icon="play_arrow"
              color="primary"
              :label="$q.screen.gt.sm ? '运行' : ''"
              class="full-width"
              :disable="runButtonDisabled"
              @click="$emit('run-model')"
            />
            <q-tooltip v-if="runButtonTooltip">{{ runButtonTooltip }}</q-tooltip>
          </span>

          <span class="toolbar-button-wrap">
            <q-btn
              flat
              icon="download"
              color="primary"
              :label="$q.screen.gt.sm ? '下载' : ''"
              class="full-width"
              :disable="downloadDisabled"
              @click="$emit('download')"
            />
            <q-tooltip>{{ downloadTooltip }}</q-tooltip>
          </span>

          <q-btn
            flat
            icon="more_vert"
            color="primary"
            class="toolbar-button"
            @click="$emit('toggle-settings')"
          >
            <q-tooltip>设置面板</q-tooltip>
          </q-btn>
        </div>
      </q-toolbar>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from "vue";
import { useQuasar } from "quasar";
import MoonshineFile from "../common/MoonshineFile.vue";

const $q = useQuasar();

const props = defineProps({
  files: {
    type: Array,
    default: () => [],
  },
  selectedFile: {
    type: Object,
    default: null,
  },
  currentModel: {
    type: String,
    default: "lama",
  },
  currentModelRequiresMask: {
    type: Boolean,
    default: true,
  },
  showMaskTools: {
    type: Boolean,
    default: false,
  },
  hasProcessedImages: {
    type: Boolean,
    default: false,
  },
  actionScope: {
    type: Object,
    default: () => ({ value: "selected" }),
  },
  engineRunDisabled: {
    type: Boolean,
    default: false,
  },
  engineRunTooltip: {
    type: String,
    default: "",
  },
  engineFailed: {
    type: Boolean,
    default: false,
  },
  type: {
    type: String,
    default: "image",
  },
});

const emit = defineEmits([
  "toggle-file-explorer",
  "rejected-files",
  "update:files",
  "toggle-mask-tools",
  "show-original",
  "show-processed",
  "undo-processing",
  "run-model",
  "open-diagnostics",
  "download",
  "toggle-settings",
]);

const localFiles = ref([]);

const fileAccept = computed(() =>
  props.type === "video" ? ".mp4,.avi,.mov,.mkv" : ".png,.jpg,.jpeg,.webp"
);

const maskToggleDisabled = computed(
  () => !props.selectedFile || !props.currentModelRequiresMask
);

const maskToggleLabel = computed(() =>
  props.showMaskTools ? "停止绘制" : "开始绘制"
);

const maskToggleTooltip = computed(() => {
  if (!props.selectedFile) return "请先选择图片";
  if (!props.currentModelRequiresMask) {
    return "当前模型不需要蒙版，绘制工具暂不可用";
  }
  return props.showMaskTools ? "隐藏绘制工具" : "显示绘制工具";
});

const compareDisabled = computed(() => !props.selectedFile || !props.hasProcessedImages);

const compareTooltip = computed(() => {
  if (!props.selectedFile) return "请先选择图片";
  if (!props.hasProcessedImages) return "当前图片还没有可对比的处理结果";
  return "按住对比原图";
});

const undoDisabled = computed(() => !props.selectedFile || !props.hasProcessedImages);

const undoTooltip = computed(() => {
  if (!props.selectedFile) return "请先选择图片";
  if (!props.hasProcessedImages) return "当前图片没有可撤销的处理记录";
  return "撤销处理";
});

const runButtonDisabled = computed(() => {
  if (props.engineRunDisabled) return true;
  if (!props.currentModel) return true;
  const canRunFolderWithoutSelectedFile =
    props.actionScope?.value === "folder" && !props.currentModelRequiresMask;
  return !props.selectedFile && !canRunFolderWithoutSelectedFile;
});

const runButtonTooltip = computed(() => {
  if (props.engineRunDisabled && props.engineRunTooltip) {
    return props.engineRunTooltip;
  }
  if (!props.currentModel) {
    return "暂无已安装模型，请进入模型管理";
  }
  if (!props.selectedFile) {
    if (props.actionScope?.value === "folder" && props.currentModelRequiresMask) {
      return "文件夹模式需要先选择一张图片并创建模板蒙版";
    }
    if (props.actionScope?.value !== "folder") {
      return "请先选择图片，或切换到文件夹作用范围";
    }
  }
  return $q.screen.gt.sm ? "" : "运行";
});

const downloadDisabled = computed(() => !props.selectedFile);

const downloadTooltip = computed(() =>
  props.selectedFile ? "下载" : "请先选择图片"
);

const handleRunWrapperClick = () => {
  if (props.engineFailed) {
    emit("open-diagnostics");
  }
};

watch(
  () => props.files,
  (newFiles) => {
    localFiles.value = newFiles;
  },
  { immediate: true }
);

const handleFilesUpdate = (newFiles) => {
  const processedFiles = newFiles.map((file) => {
    if (!Object.prototype.hasOwnProperty.call(file, "path")) {
      Object.defineProperty(file, "path", {
        value: file.webkitRelativePath || "",
        writable: false,
      });
    }
    return file;
  });
  localFiles.value = processedFiles;
  emit("update:files", processedFiles);
};
</script>

<style scoped>
.image-processing-toolbar {
  position: relative;
  display: flex;
  align-items: stretch;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  border-top: 1px solid rgba(17, 24, 39, 0.08);
}

.image-processing-toolbar > .row {
  width: 100%;
  min-width: 0;
  min-height: var(--image-toolbar-height, 60px);
  align-items: stretch;
}

.image-processing-toolbar :deep(.q-toolbar) {
  min-width: 0;
  min-height: var(--image-toolbar-height, 60px);
}

.toolbar-file-area {
  flex: 0 1 clamp(260px, 29vw, 430px);
  min-width: 240px;
}

.toolbar-actions {
  flex: 1 1 auto;
  min-width: 0;
  padding-inline: clamp(8px, 1.5vw, 22px);
}

.toolbar-button-row {
  width: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: clamp(8px, 1.2vw, 18px);
}

.toolbar-button-wrap,
.toolbar-button {
  display: inline-flex;
  min-width: 0;
  flex: 0 0 auto;
}

.toolbar-button-wrap {
  min-width: 104px;
}

.toolbar-button {
  width: 44px;
}

.toolbar-button-wrap :deep(.q-btn),
.toolbar-button {
  min-height: 42px;
  border-radius: 8px;
}

.toolbar-button-wrap :deep(.q-btn__content),
.toolbar-button :deep(.q-btn__content) {
  flex-wrap: nowrap;
  white-space: nowrap;
  gap: 8px;
}

:global(body.body--dark) .image-processing-toolbar {
  border-top-color: rgba(255, 255, 255, 0.08);
}

@media (max-width: 900px) {
  .toolbar-file-area {
    min-width: 210px;
  }

  .toolbar-button-row {
    gap: 4px;
  }

  .toolbar-button-wrap {
    min-width: 44px;
  }
}
</style>
