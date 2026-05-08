<template>
  <div class="model-selector">
    <q-select
      v-if="installedOptions.length > 1"
      v-model="selectedModel"
      :options="installedOptions"
      label="使用模型"
      filled
      emit-value
      map-options
      class="model-selector-field"
      @update:model-value="$emit('update:model-value', $event)"
    />
    <div v-else class="single-model-display">
      <div class="text-caption text-grey-7">使用模型</div>
      <div class="text-body1 text-weight-medium">
        {{ installedOptions[0]?.label || selectedModel || "暂无可用模型" }}
      </div>
    </div>
    <q-btn
      round
      dense
      flat
      icon="help_outline"
      color="primary"
      class="model-help-button"
      @click="$emit('open-model-management', selectedModel)"
    >
      <q-tooltip>查看/管理模型</q-tooltip>
    </q-btn>
  </div>
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
const emit = defineEmits(['update:model-value', 'open-model-management'])

const selectedModel = ref(props.modelValue)

const fallbackImageOptions = [
  { label: 'Lama去除模型', value: 'lama' }
]

const fallbackVideoOptions = [
  { label: '视频处理模型1', value: 'video1' },
  { label: '视频处理模型2', value: 'video2' }
]

const normalizeOption = (option) => ({
  label: option.label || option.name || option.id || option.value,
  value: option.value || option.id || option.name,
  disable: option.disable || option.installed === false,
  installed: option.installed !== false,
})

const normalizedOptions = computed(() => {
  const sourceOptions = props.options.length > 0
    ? props.options
    : props.type === 'video'
      ? fallbackVideoOptions
      : fallbackImageOptions
  return sourceOptions.map(normalizeOption).filter((option) => option.value)
})

const installedOptions = computed(() =>
  normalizedOptions.value.filter((option) => option.installed && !option.disable)
)

watch(() => props.modelValue, (newVal) => {
  selectedModel.value = newVal
})

watch(() => props.type, (newType) => {
  const hasCurrentValue = installedOptions.value.some((option) => option.value === selectedModel.value)
  if (!hasCurrentValue) {
    selectedModel.value = installedOptions.value[0]?.value || (newType === 'video' ? 'video1' : 'lama')
  }
})

watch(installedOptions, (options) => {
  if (options.some((option) => option.value === selectedModel.value)) return
  selectedModel.value = options[0]?.value || (props.type === 'video' ? 'video1' : 'lama')
})
</script>

<style scoped>
.model-selector {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
}

.model-selector-field {
  flex: 1 1 auto;
  min-width: 0;
}

.single-model-display {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 56px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 8px 12px;
  border-radius: 4px 4px 0 0;
  background: rgba(17, 24, 39, 0.06);
  border-bottom: 1px solid rgba(17, 24, 39, 0.24);
}

.single-model-display .text-body1 {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-help-button {
  flex: 0 0 auto;
}

:global(body.body--dark) .single-model-display {
  background: rgba(255, 255, 255, 0.08);
  border-bottom-color: rgba(255, 255, 255, 0.32);
}
</style>
