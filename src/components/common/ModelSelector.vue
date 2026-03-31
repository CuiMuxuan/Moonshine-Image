<template>
  <q-select
    v-model="selectedModel"
    :options="modelOptions"
    label="使用模型"
    filled
    emit-value
    map-options
    @update:model-value="$emit('update:model-value', $event)"
  />
</template>

<script setup>
import { ref, watch } from 'vue'

const props = defineProps({
  modelValue: {
    type: String,
    default: 'lama'
  },
  type: {
    type: String,
    default: 'image' // 'image' or 'video'
  }
})

// eslint-disable-next-line no-unused-vars
const emit = defineEmits(['update:model-value'])

const selectedModel = ref(props.modelValue)

const modelOptions = ref([
  { label: 'Lama去除模型', value: 'lama' },
  { label: 'OCR文字识别', value: 'ocr' },
  { label: '修复模型', value: 'repair' }
])

watch(() => props.modelValue, (newVal) => {
  selectedModel.value = newVal
})

watch(() => props.type, (newType) => {
  if (newType === 'video') {
    modelOptions.value = [
      { label: '视频处理模型1', value: 'video1' },
      { label: '视频处理模型2', value: 'video2' }
    ]
  } else {
    modelOptions.value = [
      { label: 'Lama去除模型', value: 'lama' },
      { label: 'OCR文字识别', value: 'ocr' },
      { label: '修复模型', value: 'repair' }
    ]
  }
})
</script>
