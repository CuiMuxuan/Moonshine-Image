<template>
  <q-btn-toggle
    v-model="modelValue"
    spread
    no-caps
    rounded
    unelevated
    toggle-color="deep-purple-2"
    color="primary"
    text-color="deep-purple-2"
    :toggle-text-color="'primary'"
    class="q-px-md q-py-sm"
    :options="options"
    @update:model-value="updateModelValue"
  />
</template>

<script setup>
import { ref, watch } from "vue";

const props = defineProps({
  modelValue: {
    type: String,
    required: true,
  },
  options: {
    type: Array,
    default: () => [
      { label: "去除模型", value: "remove" },
      { label: "OCR文字识别", value: "ocr" },
      { label: "修复模型", value: "repair" },
    ],
  },
});

const emit = defineEmits(["update:modelValue"]);

const modelValue = ref(props.modelValue);

watch(
  () => props.modelValue,
  (val) => {
    modelValue.value = val;
  }
);

// 使用emit函数
const updateModelValue = (value) => {
  emit("update:modelValue", value);
};
</script>