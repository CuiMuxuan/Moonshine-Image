<template>
  <q-list bordered class="file-list" :class="listClass">
    <q-item
      v-for="file in filteredFiles"
      :key="file.id"
      clickable
      :active="selectedFile?.id === file.id"
      :active-class="activeItemClass"
      class="file-list-item"
      @click="$emit('update:selected-file', file)"
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
        <q-item-label caption :class="captionClass">
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
          @click.stop="$emit('remove-file', file.id)"
        />
      </q-item-section>
    </q-item>
  </q-list>
</template>

<script setup>
import { computed } from "vue";
import { useQuasar } from "quasar";

const props = defineProps({
  files: {
    type: Array,
    required: true,
  },
  selectedFile: {
    type: Object,
    default: null,
  },
  selectedFiles: {
    type: Array,
    required: true,
  },
  fileUrls: {
    type: Object,
    required: true,
  },
});

const emit = defineEmits(["update:selected-file", "remove-file", "toggle-selection"]);

const $q = useQuasar();

const filteredFiles = computed(() =>
  props.files.filter((file) => file.type && file.type.startsWith("image/"))
);

const listClass = computed(() =>
  $q.dark.isActive ? "file-list--dark" : "file-list--light"
);
const activeItemClass = computed(() =>
  $q.dark.isActive ? "file-list-item--active-dark text-primary" : "file-list-item--active-light text-primary"
);
const captionClass = computed(() =>
  $q.dark.isActive ? "text-grey-5" : "text-grey-7"
);

const isFileSelected = (file) => {
  return props.selectedFiles.some((selectedFile) => selectedFile.id === file.id);
};

const toggleFileSelection = (file) => {
  emit("toggle-selection", file);
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
  const history = Array.isArray(file?.history) ? file.history : [];
  const latestImage = history[history.length - 1];
  const url = props.fileUrls[file.id] || latestImage?.displayUrl;

  if (url && url.startsWith("file://") && window.electron) {
    const filePath = url.replace("file://", "");
    return `atom://${filePath}`;
  }

  return url;
};
</script>

<style scoped>
.file-list {
  min-height: 100%;
  border: 0;
  box-sizing: border-box;
  padding: 4px 8px;
}

.file-list--light {
  background: #ffffff;
  color: #111827;
}

.file-list--dark {
  background: #1d1d1d;
  color: rgba(244, 244, 245, 0.94);
}

.file-list-item {
  margin: 0;
  border-radius: 10px;
  transition: background-color 0.18s ease, color 0.18s ease;
}

.file-list-item + .file-list-item {
  margin-top: 4px;
}

.file-list--light .file-list-item:hover {
  background: rgba(59, 130, 246, 0.08);
}

.file-list--dark .file-list-item:hover {
  background: rgba(255, 255, 255, 0.06);
}

.file-list-item--active-light {
  background: rgba(59, 130, 246, 0.12);
}

.file-list-item--active-dark {
  background: rgba(59, 130, 246, 0.2);
}
</style>
