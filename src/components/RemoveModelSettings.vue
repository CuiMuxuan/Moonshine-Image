<template>
  <div class="q-pa-md">
    <div class="text-h6 q-mb-md flex items-center">
      <q-icon name="settings" class="q-mr-sm" />
      运行设置
    </div>
    <q-list>
      <!-- 作用范围 -->
      <q-item>
        <q-item-section>
          <q-select
            v-model="maskScopeModel"
            :options="[
              { label: '仅当前文件', value: 'current' },
              { label: '仅选中文件', value: 'selected' },
            ]"
            label="作用范围"
            filled
            @update:model-value="updateMaskScope"
          />
        </q-item-section>
      </q-item>

      <!-- 全选开关 -->
      <q-item>
        <q-item-section>
          <q-toggle
            v-model="selectAllModel"
            label="全选文件"
            @update:model-value="onSelectAll"
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
            @click="onDeleteSelected"
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
              selectedFiles.length === 0 || !currentMask || !currentMask.data
            "
            @click="onApplyMask"
          />
        </q-item-section>
      </q-item>

      <!-- 保存路径 -->
      <q-item>
        <q-item-section>
          <q-input
            v-model="savePathModel"
            label="保存路径"
            filled
            readonly
            stack-label
            @update:model-value="updateSavePath"
          >
            <template v-slot:append>
              <q-btn
                round
                dense
                flat
                icon="folder"
                @click="onSelectPath"
              />
            </template>
          </q-input>
        </q-item-section>
      </q-item>

      <!-- CUDA状态和开关 -->
      <q-item>
        <q-item-section>
          <div class="row items-center">
            <div class="col">
              <q-badge :color="cudaAvailable ? 'positive' : 'negative'">
                CUDA {{ cudaAvailable ? "可用" : "不可用" }}
              </q-badge>
            </div>
            <div class="col">
              <q-toggle
                v-model="useCudaModel"
                label="启用CUDA"
                :disable="!cudaAvailable"
                @update:model-value="updateUseCuda"
              />
            </div>
          </div>
        </q-item-section>
      </q-item>
    </q-list>
  </div>
</template>

<script setup>
import { ref, watch } from "vue";

const props = defineProps({
  maskScope: {
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
  savePath: {
    type: String,
    default: "",
  },
  cudaAvailable: {
    type: Boolean,
    default: false,
  },
  useCuda: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits([
  "update:maskScope",
  "update:selectAll",
  "update:savePath",
  "update:useCuda",
  "select-all",
  "delete-selected",
  "apply-mask",
  "select-path",
]);

// 本地状态
const maskScopeModel = ref(props.maskScope);
const selectAllModel = ref(props.selectAll);
const savePathModel = ref(props.savePath);
const useCudaModel = ref(props.useCuda);

// 监听属性变化
watch(
  () => props.maskScope,
  (val) => {
    maskScopeModel.value = val;
  }
);

watch(
  () => props.selectAll,
  (val) => {
    selectAllModel.value = val;
  }
);

watch(
  () => props.savePath,
  (val) => {
    savePathModel.value = val;
  }
);

watch(
  () => props.useCuda,
  (val) => {
    useCudaModel.value = val;
  }
);

// 使用emit函数
const updateMaskScope = (value) => {
  emit("update:maskScope", value);
};

const updateSavePath = (value) => {
  emit("update:savePath", value);
};

const updateUseCuda = (value) => {
  emit("update:useCuda", value);
};

const onSelectAll = (value) => {
  emit("update:selectAll", value);
  emit("select-all", value);
};

const onDeleteSelected = () => {
  emit("delete-selected");
};

const onApplyMask = () => {
  emit("apply-mask");
};

const onSelectPath = () => {
  emit("select-path");
};
</script>