<template>
  <q-drawer
    v-model="drawerModel"
    show-if-above
    overlay
    side="right"
    bordered
  >
    <div class="q-pa-md">
      <div class="text-h6 q-mb-md flex items-center">
        <q-icon name="settings" class="q-mr-sm" />
        运行设置
      </div>

      <q-item>
        <q-item-section>
          <model-selector
            :model-value="currentModel"
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
                :model-value="actionScope"
                :options="[
                  { label: '仅当前文件', value: 'current' },
                  { label: '仅选中文件', value: 'selected' },
                  { label: '选中文件夹', value: 'folder' },
                ]"
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
                label="当前蒙版作用于选中文件"
                :disable="selectedFiles.length === 0 || !currentMask?.data"
                @click="$emit('apply-current-mask-to-selected')"
              />
            </q-item-section>
          </q-item>

          <q-item v-if="actionScope?.value === 'folder'">
            <q-item-section>
              <folder-selector
                :model-value="folderPath"
                label="输入文件夹"
                @update:model-value="$emit('update:folder-path', $event)"
              />
            </q-item-section>
          </q-item>

          <q-item v-if="actionScope?.value === 'folder'">
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
                :model-value="ocrLang"
                :options="['中文', '英文', '日文']"
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
          <div class="text-h6">OCR功能将在作者B站粉丝超过2000时开发</div>
        </q-list>
      </div>

      <div v-else class="text-h6">修复功能将在作者B站粉丝超过3000时开发</div>
    </div>
  </q-drawer>
</template>

<script setup>
import { computed } from "vue";

import CudaStatus from "src/components/common/CudaStatus.vue";
import FolderSelector from "src/components/common/FolderSelector.vue";
import ModelSelector from "src/components/common/ModelSelector.vue";

const props = defineProps({
  drawerOpen: {
    type: Boolean,
    default: false,
  },
  currentModel: {
    type: String,
    default: "lama",
  },
  actionScope: {
    type: Object,
    default: () => ({ label: "仅当前文件", value: "current" }),
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
  savePath: {
    type: String,
    default: "",
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
  "update:save-path",
  "update:ocr-lang",
  "update:auto-layout",
  "confirm-delete-selected",
  "apply-current-mask-to-selected",
  "cuda-status-changed",
]);

const drawerModel = computed({
  get: () => props.drawerOpen,
  set: (value) => emit("update:drawer-open", value),
});
</script>
