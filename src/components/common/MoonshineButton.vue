<template>
  <q-btn
    :round="round"
    :label="currentLabel"
    :color="currentColor"
    :text-color="currentTextColor"
    :glossy="glossy"
    :flat="flat"
    :rounded="rounded"
    :icon="currentIcon"
    :push="push"
    :size="responsiveSize"
    @click="handleClick"
  >
    <q-tooltip
      v-if="currentTooltipText"
      :anchor="tooltipAnchor"
      self="center middle"
      :transition-show="transitionShow"
      :transition-hide="transitionHide"
    >
      {{ currentTooltipText }}
    </q-tooltip>
  </q-btn>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'

// Props定义
const props = defineProps({
  // q-button属性
  round: {
    type: Boolean,
    default: false
  },
  label: {
    type: String,
    default: ''
  },
  color: {
    type: String,
    default: 'primary'
  },
  textColor: {
    type: String,
    default: ''
  },
  glossy: {
    type: Boolean,
    default: false
  },
  flat: {
    type: Boolean,
    default: false
  },
  rounded: {
    type: Boolean,
    default: false
  },
  icon: {
    type: String,
    default: ''
  },
  push: {
    type: Boolean,
    default: false
  },

  // q-tooltip属性
  anchor: {
    type: String,
    default: 'bottom', // 只接受 'bottom' 或 'top'
    validator: (value) => ['bottom', 'top'].includes(value)
  },
  transitionShow: {
    type: String,
    default: 'scale'
  },
  transitionHide: {
    type: String,
    default: 'scale'
  },
  tooltipText: {
    type: String,
    default: ''
  },

  // Toggle相关属性
  toggleColor: {
    type: String,
    default: ''
  },
  toggleIcon: {
    type: String,
    default: ''
  },
  toggleLabel: {
    type: String,
    default: ''
  },
  toggleTextColor: {
    type: String,
    default: ''
  },
  toggleTooltipText: {
    type: String,
    default: ''
  },

  // 是否启用toggle模式
  toggle: {
    type: Boolean,
    default: false
  },

  // 初始toggle状态
  modelValue: {
    type: Boolean,
    default: false
  }
})

// Emits定义
const emit = defineEmits([
  'click',
  'toggle-click',
  'update:modelValue'
])

// 响应式数据
const isToggled = ref(props.modelValue)
const screenSize = ref('md')

// 计算属性
const tooltipAnchor = computed(() => {
  return `${props.anchor} middle`
})

const responsiveSize = computed(() => {
  switch (screenSize.value) {
    case 'xs':
      return 'xs'
    case 'sm':
    case 'md':
      return 'sm'
    default:
      return 'md'
  }
})

const currentColor = computed(() => {
  if (props.toggle && isToggled.value && props.toggleColor) {
    return props.toggleColor
  }
  return props.color
})

const currentIcon = computed(() => {
  if (props.toggle && isToggled.value && props.toggleIcon) {
    return props.toggleIcon
  }
  return props.icon
})

const currentLabel = computed(() => {
  if (props.toggle && isToggled.value && props.toggleLabel) {
    return props.toggleLabel
  }
  return props.label
})

const currentTextColor = computed(() => {
  if (props.toggle && isToggled.value && props.toggleTextColor) {
    return props.toggleTextColor
  }
  return props.textColor
})

const currentTooltipText = computed(() => {
  if (props.toggle && isToggled.value && props.toggleTooltipText) {
    return props.toggleTooltipText
  }
  return props.tooltipText
})

// 方法
const updateScreenSize = () => {
  const width = window.innerWidth
  if (width < 600) {
    screenSize.value = 'xs'
  } else if (width < 1024) {
    screenSize.value = 'sm'
  } else if (width < 1440) {
    screenSize.value = 'md'
  } else if (width < 1920) {
    screenSize.value = 'lg'
  } else {
    screenSize.value = 'xl'
  }
}

const handleClick = () => {
  if (props.toggle) {
    isToggled.value = !isToggled.value
    emit('update:modelValue', isToggled.value)
    emit('toggle-click', isToggled.value)
  }
  emit('click')
}

// 生命周期
onMounted(() => {
  updateScreenSize()
  window.addEventListener('resize', updateScreenSize)
})

onUnmounted(() => {
  window.removeEventListener('resize', updateScreenSize)
})

// 监听modelValue变化
watch(() => props.modelValue, (newValue) => {
  isToggled.value = newValue
})
</script>

<style scoped>
/* 可以添加自定义样式 */
</style>
