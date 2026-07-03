<template>
  <div class="file-list-shell" :class="listClass">
    <div class="file-list-toolbar">
      <q-btn
        dense
        flat
        no-caps
        icon="select_all"
        label="全选"
        :color="allVisibleImagesSelected ? 'primary' : undefined"
        data-testid="image-file-list-select-all"
        :disable="filteredFiles.length === 0"
        @click="$emit('select-all')"
      />
      <q-btn
        dense
        flat
        no-caps
        icon="flip_to_back"
        label="反选"
        data-testid="image-file-list-invert-selection"
        :disable="filteredFiles.length === 0"
        @click="$emit('invert-selection')"
      />
      <q-btn
        dense
        flat
        no-caps
        color="negative"
        icon="delete"
        label="删除"
        data-testid="image-file-list-delete-selected"
        :disable="selectedFiles.length === 0"
        @click="$emit('delete-selected')"
      />
    </div>

    <q-virtual-scroll
      :items="filteredFiles"
      :virtual-scroll-item-size="72"
      type="list"
      class="file-list"
      @virtual-scroll="handleVirtualScroll"
      v-slot="{ item: file }"
    >
      <q-item
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
            color="primary"
            class="file-list-checkbox"
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

        <q-item-section class="file-list-meta">
          <q-item-label class="file-list-name">
            {{ formatMiddleEllipsis(file.name) }}
            <q-tooltip>{{ file.name }}</q-tooltip>
          </q-item-label>
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
    </q-virtual-scroll>
  </div>
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

const emit = defineEmits([
  "update:selected-file",
  "remove-file",
  "toggle-selection",
  "select-all",
  "invert-selection",
  "delete-selected",
  "visible-range-change",
]);

const $q = useQuasar();

const filteredFiles = computed(() =>
  props.files.filter((file) => file.type && file.type.startsWith("image/"))
);

const emitVisibleRange = (range = {}) => {
  const from = Math.max(0, Number(range.from ?? range.index ?? 0));
  const to = Math.min(
    filteredFiles.value.length - 1,
    Math.max(from, Number(range.to ?? range.index ?? from))
  );
  if (to < from) return;
  emit("visible-range-change", {
    from,
    to,
    index: Number(range.index ?? from),
    direction: range.direction || "",
    fileIds: filteredFiles.value.slice(from, to + 1).map((file) => file.id).filter(Boolean),
  });
};

const handleVirtualScroll = (range = {}) => {
  emitVisibleRange(range);
};

const listClass = computed(() =>
  $q.dark.isActive ? "file-list--dark" : "file-list--light"
);
const activeItemClass = computed(() =>
  $q.dark.isActive ? "file-list-item--active-dark" : "file-list-item--active-light"
);
const captionClass = computed(() =>
  $q.dark.isActive ? "text-grey-5" : "text-grey-7"
);
const allVisibleImagesSelected = computed(() =>
  filteredFiles.value.length > 0 &&
  filteredFiles.value.every((file) => isFileSelected(file))
);

const isFileSelected = (file) => {
  return props.selectedFiles.some((selectedFile) => selectedFile.id === file.id);
};

const toggleFileSelection = (file) => {
  emit("toggle-selection", file);
};

const formatMiddleEllipsis = (fileName = "") => {
  const normalized = String(fileName || "");
  if (normalized.length <= 28) {
    return normalized;
  }

  const extensionMatch = normalized.match(/(\.[^.]{1,12})$/);
  const extension = extensionMatch?.[1] || "";
  const nameWithoutExtension = extension
    ? normalized.slice(0, -extension.length)
    : normalized;
  const head = nameWithoutExtension.slice(0, 12);
  const tail = nameWithoutExtension.slice(-8);
  return `${head}...${tail}${extension}`;
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
.file-list-shell {
  height: 100%;
  min-height: 100%;
  display: flex;
  flex-direction: column;
  border: 0;
  box-sizing: border-box;
}

.file-list {
  flex: 1 1 auto;
  min-height: 0;
  padding: 4px 8px;
}

.file-list-toolbar {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
  padding: 8px 8px 4px;
}

.file-list-toolbar :deep(.q-btn__content) {
  flex-wrap: nowrap;
  gap: 4px;
  min-width: 0;
}

.file-list-toolbar :deep(.q-btn__content span) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.file-list-meta {
  min-width: 0;
}

.file-list-name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  color: var(--q-primary);
}

.file-list-item--active-dark {
  background: rgba(59, 130, 246, 0.2);
  color: var(--q-secondary);
}

.file-list-item :deep(.file-list-checkbox) {
  color: var(--q-primary);
}

.file-list-item :deep(.file-list-checkbox .q-checkbox__inner--falsy) {
  color: rgba(113, 113, 122, 0.82);
}

.file-list--dark .file-list-item :deep(.file-list-checkbox .q-checkbox__inner--falsy) {
  color: rgba(228, 228, 231, 0.68);
}

.file-list-item :deep(.file-list-checkbox .q-checkbox__inner--truthy .q-checkbox__bg) {
  color: var(--q-primary);
}

.file-list-item :deep(.file-list-checkbox .q-checkbox__inner--truthy .q-checkbox__svg) {
  color: #ffffff !important;
}

.file-list-item :deep(.file-list-checkbox .q-checkbox__inner--truthy .q-checkbox__truthy) {
  stroke: #ffffff !important;
}
</style>
