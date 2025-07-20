<template>
  <q-list bordered>
    <q-item
      v-for="(file, index) in filteredFiles"
      :key="file.id"
      clickable
      :active="selectedFile?.id === file.id"
      @click="$emit('update:selected-file', file)"
      active-class="bg-blue-1 text-primary"
    >
      <q-item-section avatar>
        <q-checkbox
          :model-value="isFileSelected(file)"
          :val="file"
          @update:model-value="toggleFileSelection(file)"
          @click.stop
        />
      </q-item-section>

      <q-item-section avatar>
        <q-avatar square>
          <img
            :src="getFileDisplayUrl(file)"
            style="width: 100%; height: 100%; object-fit: cover"
            @error="(e) => (e.target.src = getFileIcon(file))"
          />
        </q-avatar>
      </q-item-section>

      <q-item-section>
        <q-item-label>{{ file.name }}</q-item-label>
        <q-item-label caption>
          {{ (file.size / 1024).toFixed(2) }} KB
        </q-item-label>
      </q-item-section>

      <q-item-section side>
        <q-btn
          round
          dense
          flat
          icon="delete"
          color="negative"
          @click.stop="$emit('remove-file', index)"
        />
      </q-item-section>
    </q-item>
  </q-list>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  files: {
    type: Array,
    required: true
  },
  selectedFile: {
    type: Object,
    default: null
  },
  selectedFiles: {
    type: Array,
    required: true
  },
  fileUrls: {
    type: Object,
    required: true
  }
});

const emit = defineEmits(['update:selected-file', 'remove-file', 'toggle-selection']);

const filteredFiles = computed(() =>
  props.files.filter((f) => f.type && f.type.startsWith("image/"))
)

const isFileSelected = (file) => {
  return props.selectedFiles.some(f => f.id === file.id)
}

const toggleFileSelection = (file) => {
  emit('toggle-selection', file);
};

const getFileIcon = (file) => {
  const type = file.type?.split("/")[0] || "";
  return (
    {
      image: "photo",
      video: "movie",
      audio: "music_note",
      text: "description",
      application: "insert_drive_file",
    }[type] || "insert_drive_file"
  );
};
const getFileDisplayUrl = (file) => {
  const url = props.fileUrls[file.name];

  // 如果是文件路径且在Electron环境中
  if (url && url.startsWith('file://') && window.electron) {
    // 转换为Electron可访问的协议
    const filePath = url.replace('file://', '');
    return `atom://${filePath.replace(/\\/g, '/')}`;
  }

  return url;
};
</script>

<style scoped>
/* 添加自定义间距 */
.q-item {
  margin: 4px 0;
  border-radius: 4px;
}
</style>
