<template>
  <q-select
    v-model="selectedModel"
    :options="normalizedOptions"
    label="使用模型"
    filled
    emit-value
    map-options
    @update:model-value="$emit('update:model-value', $event)"
  />
</template>

<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  modelValue: {
    type: String,
    default: 'lama'
  },
  type: {
    type: String,
    default: 'image' // 'image' or 'video'
  },
  options: {
    type: Array,
    default: () => []
  }
})

// eslint-disable-next-line no-unused-vars
const emit = defineEmits(['update:model-value'])

const selectedModel = ref(props.modelValue)

const fallbackImageOptions = [
  { label: 'Lama去除模型', value: 'lama' },
  { label: 'OCR文字识别', value: 'ocr' },
  { label: '修复模型', value: 'repair' }
]

const fallbackVideoOptions = [
  { label: '视频处理模型1', value: 'video1' },
  { label: '视频处理模型2', value: 'video2' }
]

const normalizeOption = (option) => ({
  label: option.label || option.name || option.id || option.value,
  value: option.value || option.id || option.name,
  disable: option.disable || option.installed === false,
})

const normalizedOptions = computed(() => {
  const sourceOptions = props.options.length > 0
    ? props.options
    : props.type === 'video'
      ? fallbackVideoOptions
      : fallbackImageOptions
  return sourceOptions.map(normalizeOption).filter((option) => option.value)
})

watch(() => props.modelValue, (newVal) => {
  selectedModel.value = newVal
})

watch(() => props.type, (newType) => {
  const hasCurrentValue = normalizedOptions.value.some((option) => option.value === selectedModel.value)
  if (!hasCurrentValue) {
    selectedModel.value = normalizedOptions.value[0]?.value || (newType === 'video' ? 'video1' : 'lama')
  }
})

watch(normalizedOptions, (options) => {
  if (options.some((option) => option.value === selectedModel.value)) return
  selectedModel.value = options[0]?.value || (props.type === 'video' ? 'video1' : 'lama')
})
</script>
