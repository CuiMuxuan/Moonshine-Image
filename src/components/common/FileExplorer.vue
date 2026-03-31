<template>
  <q-drawer
    show-if-above
    overlay
    bordered
    v-model="drawerModel"
    side="left"
    elevated
    :class="drawerClass"
  >
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
import { useQuasar } from "quasar";
import FileList from './FileList.vue'

const $q = useQuasar();

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

const drawerClass = computed(() =>
  $q.dark.isActive
    ? "file-explorer-drawer file-explorer-drawer--dark"
    : "file-explorer-drawer file-explorer-drawer--light"
)
</script>

<style scoped>
.file-explorer-drawer {
  color: inherit;
}

.file-explorer-drawer--light {
  background: #ffffff;
}

.file-explorer-drawer--dark {
  background: #1d1d1d;
  color: rgba(244, 244, 245, 0.94);
}
</style>
