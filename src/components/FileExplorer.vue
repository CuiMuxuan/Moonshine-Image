<template>
  <q-drawer show-if-above v-model="drawerModel" side="left" elevated>
    <file-list
      :files="files"
      :selected-file="selectedFile"
      :selected-files="selectedFiles"
      :file-urls="fileUrls"
      @update:selected-file="$emit('update:selected-file', $event)"
      @toggle-selection="$emit('toggle-selection', $event)"
      @remove-file="$emit('remove-file', $event)"
    />
  </q-drawer>
</template>

<script setup>
import { computed } from 'vue'
import FileList from './FileList.vue'

const props = defineProps({
  drawerOpen: {
    type: Boolean,
    default: true
  },
  files: {
    type: Array,
    default: () => []
  },
  selectedFile: {
    type: Object,
    default: null
  },
  selectedFiles: {
    type: Array,
    default: () => []
  },
  fileUrls: {
    type: Object,
    default: () => ({})
  }
})

const emit = defineEmits([
  'update:drawer-open',
  'update:selected-file',
  'toggle-selection',
  'remove-file'
])
// 使用计算属性处理双向绑定
const drawerModel = computed({
  get() {
    return props.drawerOpen
  },
  set(value) {
    emit('update:drawer-open', value)
  }
})
</script>
