<template>
  <q-drawer v-model="drawerModel" show-if-above overlay side="right" bordered>
    <div class="q-pa-md">
      <div class="text-h6 q-mb-md flex items-center">
        <q-icon name="settings" class="q-mr-sm" />
        运行设置
      </div>

      <q-item>
        <q-item-section>
          <model-selector
            :model-value="currentModel"
            :options="modelOptions"
            type="image"
            @update:model-value="$emit('update:current-model', $event)"
          />
        </q-item-section>
      </q-item>

      <div v-if="currentModel === 'lama'">
        <q-list>
          <q-item>
            <q-item-section>
              <q-select
                :model-value="normalizedActionScope"
                :options="actionScopeOptions"
                label="作用范围"
                filled
                @update:model-value="$emit('update:action-scope', $event)"
              />
            </q-item-section>
          </q-item>

          <q-item>
            <q-item-section>
              <q-toggle
                :model-value="selectAll"
                label="全选文件"
                @update:model-value="$emit('update:select-all', $event)"
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
                @click="$emit('confirm-delete-selected')"
              />
            </q-item-section>
          </q-item>

          <q-item>
            <q-item-section>
              <q-btn
                color="primary"
                icon="content_copy"
                label="将当前蒙版作用于选中文件"
                :disable="selectedFiles.length === 0 || !currentMask?.data"
                @click="$emit('apply-current-mask-to-selected')"
              />
            </q-item-section>
          </q-item>

          <q-item v-if="normalizedActionScope?.value === 'folder'">
            <q-item-section>
              <folder-selector
                :model-value="folderPath"
                label="输入文件夹"
                @update:model-value="$emit('update:folder-path', $event)"
              />
            </q-item-section>
          </q-item>

          <q-item v-if="normalizedActionScope?.value === 'folder'">
            <q-item-section>
              <folder-selector
                :model-value="maskFolderPath"
                label="蒙版文件夹"
                @update:model-value="$emit('update:mask-folder-path', $event)"
              />
            </q-item-section>
          </q-item>

          <q-item>
            <q-item-section>
              <folder-selector
                :model-value="savePath"
                label="保存路径"
                @update:model-value="$emit('update:save-path', $event)"
              />
            </q-item-section>
          </q-item>

          <q-item>
            <q-item-section>
              <q-btn
                outline
                color="primary"
                icon="folder_open"
                label="打开保存路径"
                :disable="!canOpenSavePath"
                @click="$emit('open-save-path')"
              />
            </q-item-section>
          </q-item>

          <q-item>
            <q-item-section>
              <cuda-status
                :backend-running="backendRunning"
                @cuda-status-changed="$emit('cuda-status-changed', $event)"
              />
            </q-item-section>
          </q-item>
        </q-list>
      </div>

      <div v-else-if="currentModel === 'slbr'">
        <q-list>
          <q-item>
            <q-item-section>
              <q-select
                :model-value="normalizedActionScope"
                :options="actionScopeOptions"
                label="作用范围"
                filled
                @update:model-value="$emit('update:action-scope', $event)"
              />
            </q-item-section>
          </q-item>

          <q-item>
            <q-item-section>
              <q-toggle
                :model-value="selectAll"
                label="全选文件"
                @update:model-value="$emit('update:select-all', $event)"
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
                @click="$emit('confirm-delete-selected')"
              />
            </q-item-section>
          </q-item>

          <q-item v-if="normalizedActionScope?.value === 'folder'">
            <q-item-section>
              <folder-selector
                :model-value="folderPath"
                label="输入文件夹"
                @update:model-value="$emit('update:folder-path', $event)"
              />
            </q-item-section>
          </q-item>

          <q-item>
            <q-item-section>
              <folder-selector
                :model-value="savePath"
                label="保存路径"
                @update:model-value="$emit('update:save-path', $event)"
              />
            </q-item-section>
          </q-item>

          <q-item>
            <q-item-section>
              <q-select
                :model-value="slbrTileSize"
                :options="normalizedSlbrTileSizeOptions"
                label="tile_size"
                filled
                emit-value
                map-options
                @update:model-value="$emit('update:slbr-tile-size', $event)"
              />
            </q-item-section>
          </q-item>

          <q-item>
            <q-item-section>
              <q-input
                :model-value="slbrTileBatch"
                type="number"
                label="tile_batch"
                filled
                :min="1"
                :max="32"
                :step="1"
                :rules="slbrTileBatchRules"
                @update:model-value="$emit('update:slbr-tile-batch', $event)"
              />
            </q-item-section>
          </q-item>

          <q-item>
            <q-item-section>
              <q-btn
                outline
                color="primary"
                icon="auto_fix_high"
                label="使用推荐参数"
                @click="$emit('apply-slbr-recommended')"
              />
            </q-item-section>
          </q-item>

          <q-item>
            <q-item-section>
              <q-btn
                outline
                color="primary"
                icon="folder_open"
                label="打开保存路径"
                :disable="!canOpenSavePath"
                @click="$emit('open-save-path')"
              />
            </q-item-section>
          </q-item>

          <q-item>
            <q-item-section>
              <cuda-status
                :backend-running="backendRunning"
                @cuda-status-changed="$emit('cuda-status-changed', $event)"
              />
            </q-item-section>
          </q-item>
        </q-list>
      </div>

      <div v-else-if="currentModel === 'ocr'">
        <q-list>
          <q-item>
            <q-item-section>
              <q-select
                :model-value="normalizedOcrLang"
                :options="ocrLangOptions"
                label="识别语言"
                filled
                @update:model-value="$emit('update:ocr-lang', $event)"
              />
            </q-item-section>
          </q-item>
          <q-item>
            <q-item-section>
              <q-toggle
                :model-value="autoLayout"
                label="自动版面分析"
                @update:model-value="$emit('update:auto-layout', $event)"
              />
            </q-item-section>
          </q-item>
          <div class="text-h6">OCR 功能将在作者 B 站粉丝超过 1000 时开放</div>
        </q-list>
      </div>

      <div v-else class="text-h6">修复功能将在作者 B 站粉丝超过 1000 时开放</div>
    </div>
  </q-drawer>
</template>

<script setup>
import { computed } from "vue";

import CudaStatus from "src/components/common/CudaStatus.vue";
import FolderSelector from "src/components/common/FolderSelector.vue";
import ModelSelector from "src/components/common/ModelSelector.vue";

const actionScopeOptions = [
  { label: "仅选中文件", value: "selected" },
  { label: "整个文件夹", value: "folder" },
];

const ocrLangOptions = ["中文", "英文", "日文"];

const props = defineProps({
  drawerOpen: {
    type: Boolean,
    default: false,
  },
  currentModel: {
    type: String,
    default: "lama",
  },
  modelOptions: {
    type: Array,
    default: () => [],
  },
  actionScope: {
    type: Object,
    default: () => ({ label: "仅选中文件", value: "selected" }),
  },
  selectAll: {
    type: Boolean,
    default: false,
  },
  selectedFiles: {
    type: Array,
    default: () => [],
  },
  currentMask: {
    type: Object,
    default: null,
  },
  folderPath: {
    type: String,
    default: "",
  },
  maskFolderPath: {
    type: String,
    default: "",
  },
  slbrTileSize: {
    type: Number,
    default: 384,
  },
  slbrTileBatch: {
    type: Number,
    default: 4,
  },
  slbrRecommended: {
    type: Object,
    default: () => ({}),
  },
  slbrTileSizeOptions: {
    type: Array,
    default: () => [256, 384, 512],
  },
  savePath: {
    type: String,
    default: "",
  },
  canOpenSavePath: {
    type: Boolean,
    default: false,
  },
  ocrLang: {
    type: String,
    default: "中文",
  },
  autoLayout: {
    type: Boolean,
    default: true,
  },
  backendRunning: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits([
  "update:drawer-open",
  "update:current-model",
  "update:action-scope",
  "update:select-all",
  "update:folder-path",
  "update:mask-folder-path",
  "update:slbr-tile-size",
  "update:slbr-tile-batch",
  "apply-slbr-recommended",
  "update:save-path",
  "update:ocr-lang",
  "update:auto-layout",
  "confirm-delete-selected",
  "apply-current-mask-to-selected",
  "open-save-path",
  "cuda-status-changed",
]);

const normalizedActionScope = computed(() => {
  const matched = actionScopeOptions.find((option) => option.value === props.actionScope?.value);
  return matched || actionScopeOptions[0];
});

const normalizedSlbrTileSizeOptions = computed(() =>
  (props.slbrTileSizeOptions || [256, 384, 512]).map((value) => ({
    label: String(value),
    value,
  }))
);

const slbrTileBatchRules = [
  (value) => {
    const numeric = Number(value);
    return (
      Number.isInteger(numeric) &&
      numeric >= 1 &&
      numeric <= 32
    ) || "请输入 1-32 的正整数";
  },
];

const normalizedOcrLang = computed(() =>
  ocrLangOptions.includes(props.ocrLang) ? props.ocrLang : "中文"
);

const drawerModel = computed({
  get: () => props.drawerOpen,
  set: (value) => emit("update:drawer-open", value),
});
</script>
