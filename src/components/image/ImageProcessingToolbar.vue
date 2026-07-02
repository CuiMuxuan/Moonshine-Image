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
          :label="toolbarTextVisible ? '选择文件' : ''"
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
            <div
              class="mask-mode-toggle"
              role="group"
              aria-label="蒙版模式"
            >
              <span
                v-for="button in visibleMaskModeButtons"
                :key="button.value"
                class="mask-mode-button-target"
                :class="{
                  'mask-mode-button-target--active': maskMode === button.value,
                  'mask-mode-button-target--labeled': Boolean(maskModeButtonLabel(button)),
                }"
                @click="handleMaskModeTargetClick(button)"
              >
                <q-btn
                  no-caps
                  unelevated
                  :icon="button.icon"
                  :label="maskModeButtonLabel(button)"
                  :aria-label="button.label"
                  :data-testid="`image-mask-mode-${button.value}`"
                  class="mask-mode-button"
                  :class="{ 'mask-mode-button--active': maskMode === button.value }"
                  :color="maskModeButtonColor(button)"
                  :text-color="maskModeButtonTextColor(button)"
                  :disable="maskModeButtonDisabled(button)"
                  @click.stop="handleMaskModeButtonClick(button)"
                />
                <q-tooltip>{{ maskModeButtonTooltip(button) }}</q-tooltip>
              </span>
            </div>
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
              :icon="runButtonIcon"
              color="primary"
              :label="runButtonLabel"
              :loading="enginePreparing"
              class="full-width"
              :disable="runButtonDisabled"
              @click="$emit('run-model')"
            >
              <template #loading>
                <q-spinner size="20px" class="on-left" />
                <span v-if="runButtonLabel">{{ runButtonLabel }}</span>
              </template>
            </q-btn>
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
  maskMode: {
    type: String,
    default: "off",
  },
  smartSelectionAvailable: {
    type: Boolean,
    default: false,
  },
  backendReady: {
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
  enginePreparing: {
    type: Boolean,
    default: false,
  },
  enginePreparingLabel: {
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
  "update:mask-mode",
  "cycle-mask-mode",
  "show-original",
  "show-processed",
  "undo-processing",
  "run-model",
  "open-diagnostics",
  "smart-selection-blocked",
  "download",
  "toggle-settings",
]);

const localFiles = ref([]);

const fileAccept = computed(() =>
  props.type === "video" ? ".mp4,.avi,.mov,.mkv" : ".png,.jpg,.jpeg,.webp"
);

const toolbarTextVisible = computed(() => $q.screen.gt.sm);

const smartSelectionDisabledReason = computed(() => {
  if (!props.backendReady) return "后端服务启动成功后可用";
  if (!props.smartSelectionAvailable) {
    return "智能选区需要先安装 SAM1/SAM2.1 点选模型或 SAM3 文本模型";
  }
  return "";
});

const maskModeButtons = computed(() => [
  {
    label: "关闭",
    value: "off",
    icon: "visibility_off",
    tooltip: "关闭蒙版编辑",
  },
  {
    label: "手动",
    value: "manual",
    icon: "edit",
    tooltip: "手动绘制蒙版",
  },
  {
    label: "智能",
    value: "smart",
    icon: "center_focus_strong",
    tooltip: "智能选区：单击点选，拖拽框选",
  },
]);

const currentMaskModeButton = computed(
  () =>
    maskModeButtons.value.find((button) => button.value === props.maskMode) ||
    maskModeButtons.value[0]
);

const visibleMaskModeButtons = computed(() =>
  $q.screen.gt.xs ? maskModeButtons.value : [currentMaskModeButton.value]
);

const maskModeButtonLabel = (button) =>
  toolbarTextVisible.value && props.maskMode === button.value ? button.label : "";

const baseMaskModeDisabledReason = computed(() => {
  if (!props.selectedFile) return "请先选择图片";
  if (!props.currentModelRequiresMask) {
    return "当前模型不需要蒙版，蒙版工具暂不可用";
  }
  return "";
});

const maskModeButtonDisabledReason = (button) => {
  if (baseMaskModeDisabledReason.value) return baseMaskModeDisabledReason.value;
  if (button.value === "smart") return smartSelectionDisabledReason.value;
  return "";
};

const maskModeButtonDisabled = (button) =>
  Boolean(maskModeButtonDisabledReason(button));

const maskModeButtonTooltip = (button) =>
  maskModeButtonDisabledReason(button) || button.tooltip;

const maskModeButtonColor = (button) => {
  if (props.maskMode === button.value) return "primary";
  return $q.dark.isActive ? "grey-9" : "grey-3";
};

const maskModeButtonTextColor = (button) => {
  if (props.maskMode === button.value) return "white";
  return $q.dark.isActive ? "grey-3" : "primary";
};

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

const runButtonPreparingText = computed(
  () => props.enginePreparingLabel || props.engineRunTooltip || "正在启动后端服务"
);

const runButtonIcon = computed(() =>
  props.enginePreparing ? "sync" : "play_arrow"
);

const runButtonLabel = computed(() => {
  if (props.enginePreparing) {
    return $q.screen.gt.xs ? "启动中" : "";
  }
  return $q.screen.gt.sm ? "运行" : "";
});

const runButtonDisabled = computed(() => {
  if (props.enginePreparing) return true;
  if (props.engineRunDisabled) return true;
  if (!props.currentModel) return true;
  const canRunFolderWithoutSelectedFile =
    props.actionScope?.value === "folder" && !props.currentModelRequiresMask;
  return !props.selectedFile && !canRunFolderWithoutSelectedFile;
});

const runButtonTooltip = computed(() => {
  if (props.enginePreparing) {
    return runButtonPreparingText.value;
  }
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

const emitBlockedSmartSelection = (button, reason) => {
  if (button.value !== "smart" || !reason) {
    return;
  }
  emit("smart-selection-blocked", reason);
};

const handleMaskModeButtonClick = (button) => {
  const disabledReason = maskModeButtonDisabledReason(button);
  emitBlockedSmartSelection(button, disabledReason);
  if (disabledReason) return;
  if (!$q.screen.gt.xs) {
    emit("cycle-mask-mode");
    return;
  }
  emit("update:mask-mode", button.value);
};

const handleMaskModeTargetClick = (button) => {
  emitBlockedSmartSelection(button, maskModeButtonDisabledReason(button));
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

.toolbar-button-wrap:has(.mask-mode-toggle) {
  min-width: 148px;
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

.mask-mode-toggle {
  min-height: 42px;
  display: inline-flex;
  align-items: stretch;
  width: auto;
  border-radius: 8px;
  overflow: hidden;
}

.mask-mode-button-target {
  display: inline-flex;
  flex: 0 0 auto;
}

.mask-mode-button {
  width: 42px;
  min-width: 42px;
  min-height: 42px;
  padding-inline: 0;
  border-radius: 0;
}

.mask-mode-button-target:first-child .mask-mode-button {
  border-top-left-radius: 8px;
  border-bottom-left-radius: 8px;
}

.mask-mode-button-target:last-child .mask-mode-button {
  border-top-right-radius: 8px;
  border-bottom-right-radius: 8px;
}

.mask-mode-button-target--labeled .mask-mode-button {
  width: auto;
  min-width: 0;
  padding-inline: 10px 12px;
}

.mask-mode-button :deep(.q-btn__content) {
  min-width: 0;
  flex-wrap: nowrap;
  white-space: nowrap;
  gap: 0;
}

.mask-mode-button :deep(.q-icon.on-left) {
  margin-right: 4px;
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

  .toolbar-button-wrap:has(.mask-mode-toggle) {
    min-width: 128px;
  }
}

@media (max-width: 599px) {
  .toolbar-file-area {
    flex: 0 0 96px;
    width: 96px;
    min-width: 96px;
    padding-inline: 4px;
  }

  .toolbar-file-area > .q-btn {
    margin-right: 4px;
    width: 40px;
    min-width: 40px;
  }

  .toolbar-file-area :deep(.moonshine-file-wrapper) {
    width: 44px;
    min-width: 44px;
    flex: 0 0 44px;
  }

  .toolbar-actions {
    flex: 1 1 0;
    padding-inline: 4px;
  }

  .toolbar-button-row {
    justify-content: flex-end;
    gap: 2px;
  }

  .toolbar-button-wrap,
  .toolbar-button-wrap :deep(.q-btn),
  .toolbar-button {
    width: 40px;
    min-width: 40px;
  }

  .toolbar-button-wrap :deep(.q-btn),
  .toolbar-button {
    padding-inline: 0;
  }

  .toolbar-button-wrap:has(.mask-mode-toggle) {
    min-width: 40px;
  }

  .mask-mode-button {
    width: 40px;
    min-width: 40px;
    padding-inline: 0;
    border-radius: 8px;
  }

  .mask-mode-button-target--labeled .mask-mode-button {
    min-width: 40px;
  }
}
</style>
