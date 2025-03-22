<template>
  <q-list bordered>
    <q-item
      v-for="(file, index) in filteredFiles"
      :key="file.name"
      clickable
      :active="selectedFile?.name === file.name"
      @click="$emit('update:selectedFile', file)"
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
            :src="fileUrls[file.name]"
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

const emit = defineEmits(['update:selectedFile', 'remove-file', 'toggle-selection']);

const filteredFiles = computed(() =>
  props.files.filter((f) => f.type.startsWith("image/"))
);

const isFileSelected = (file) => {
  return props.selectedFiles.some(f => f.name === file.name);
};

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
</script>

<style scoped>
/* 添加自定义间距 */
.q-item {
  margin: 4px 0;
  border-radius: 4px;
}
</style>