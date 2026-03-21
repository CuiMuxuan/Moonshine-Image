<template>
  <q-file
    v-model="model"
    :accept="acceptValue"
    max-files="1"
    filled
    label="选择视频文件"
    @update:model-value="handleFileChange"
  >
    <template #before>
      <q-icon name="folder_open" />
    </template>

    <template #hint>
      支持 {{ supportedFormatText }} 视频
    </template>

    <template #file="{ file }">
      <q-chip removable color="primary" text-color="white" icon="movie" @remove="removeFile">
        <div class="ellipsis relative-position">
          {{ file.name }}
          <q-tooltip>{{ file.name }} ({{ formatFileSize(file.size) }})</q-tooltip>
        </div>
      </q-chip>
    </template>
  </q-file>
</template>

<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { useVideoManagerStore } from "src/stores/videoManager";
import { useConfigStore } from "src/stores/config";

const videoStore = useVideoManagerStore();
const configStore = useConfigStore();
const model = ref(null);
const fallbackFormats = ["mp4", "mov", "avi", "mkv", "wmv"];
const supportedFormats = computed(
  () => configStore.config.video?.supportedFormats || fallbackFormats
);
const acceptValue = computed(() => supportedFormats.value.map((ext) => `.${ext}`).join(","));
const supportedFormatText = computed(() =>
  supportedFormats.value.map((ext) => ext.toUpperCase()).join(" / ")
);

onMounted(() => {
  if (videoStore.videoFile) {
    model.value = videoStore.videoFile;
  }
});

const handleFileChange = async (file) => {
  if (!file) {
    videoStore.clearVideoFile();
    return;
  }

  const extension = String(file.name || "")
    .split(".")
    .pop()
    ?.toLowerCase();
  if (!extension || !supportedFormats.value.includes(extension)) {
    model.value = null;
    return;
  }

  await videoStore.setVideoFile(file, {
    resetEditor: true,
    resetHistory: true,
    isReplacementSource: false,
    sourcePath: file.path || "",
    sourceName: file.name || "",
  });
};

const removeFile = () => {
  model.value = null;
  videoStore.clearVideoFile();
};

const formatFileSize = (bytes) => {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
};

watch(
  () => videoStore.videoFile,
  (newFile) => {
    if (!newFile) model.value = null;
  }
);
</script>
