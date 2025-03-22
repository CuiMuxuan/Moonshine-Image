<template>
  <div class="q-pa-md">
    <div class="text-h6 q-mb-md flex items-center">
      <q-icon name="healing" class="q-mr-sm" />
      修复设置
    </div>

    <q-list>
      <q-item>
        <q-item-section>
          <q-select
            v-model="repairModel"
            :options="[
              { label: '通用修复', value: 'general' },
              { label: '人脸修复', value: 'face' },
              { label: '老照片修复', value: 'old' },
            ]"
            label="修复模型"
            filled
            @update:model-value="updateRepairModel"
          />
        </q-item-section>
      </q-item>

      <q-item>
        <q-item-section>
          <q-slider
            v-model="repairStrength"
            :min="0"
            :max="100"
            label
            label-always
            :label-value="`修复强度: ${repairStrength}%`"
            @update:model-value="updateRepairStrength"
          />
        </q-item-section>
      </q-item>

      <q-item>
        <q-item-section>
          <q-toggle
            v-model="enhanceDetails"
            label="增强细节"
            @update:model-value="updateEnhanceDetails"
          />
        </q-item-section>
      </q-item>

      <q-item>
        <q-item-section>
          <q-toggle
            v-model="colorCorrection"
            label="颜色校正"
            @update:model-value="updateColorCorrection"
          />
        </q-item-section>
      </q-item>

      <q-item>
        <q-item-section>
          <q-btn
            color="primary"
            icon="auto_fix_high"
            label="开始修复"
            @click="startRepair"
            :disable="!hasSelectedFile"
          />
        </q-item-section>
      </q-item>
    </q-list>
  </div>
</template>

<script setup>
import { ref, watch } from "vue";

const props = defineProps({
  hasSelectedFile: {
    type: Boolean,
    default: false,
  },
  repairModel: {
    type: Object,
    default: () => ({ label: "通用修复", value: "general" }),
  },
  repairStrength: {
    type: Number,
    default: 50,
  },
  enhanceDetails: {
    type: Boolean,
    default: true,
  },
  colorCorrection: {
    type: Boolean,
    default: true,
  },
});

const emit = defineEmits([
  "update:repairModel",
  "update:repairStrength",
  "update:enhanceDetails",
  "update:colorCorrection",
  "start-repair",
]);

// 本地状态 - 使用props初始化
const repairModel = ref(props.repairModel);
const repairStrength = ref(props.repairStrength);
const enhanceDetails = ref(props.enhanceDetails);
const colorCorrection = ref(props.colorCorrection);

// 监听props变化
watch(() => props.repairModel, (val) => {
  repairModel.value = val;
});

watch(() => props.repairStrength, (val) => {
  repairStrength.value = val;
});

watch(() => props.enhanceDetails, (val) => {
  enhanceDetails.value = val;
});

watch(() => props.colorCorrection, (val) => {
  colorCorrection.value = val;
});

// Use emit function in methods
const updateRepairModel = (value) => {
  emit("update:repairModel", value);
};

const updateRepairStrength = (value) => {
  emit("update:repairStrength", value);
};

const updateEnhanceDetails = (value) => {
  emit("update:enhanceDetails", value);
};

const updateColorCorrection = (value) => {
  emit("update:colorCorrection", value);
};

const startRepair = () => {
  emit("start-repair");
};
</script>