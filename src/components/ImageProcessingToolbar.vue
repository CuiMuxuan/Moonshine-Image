<template>
  <q-footer bordered class="bg-grey-8 text-white">
    <div class="row no-wrap shadow-1">
      <q-toolbar class="col-4 bg-deep-purple-2">
        <q-btn
          flat
          round
          dense
          icon="folder_open"
          class="q-mr-sm text-primary"
          @click="$emit('toggle-file-explorer')"
        >
          <q-tooltip>文件目录</q-tooltip>
        </q-btn>

        <!-- <q-file
          ref="fileInput"
          v-model="localFiles"
          label="选择文件"
          filled
          counter
          multiple
          append
          use-chips
          class="full-width"
          style="margin-top: 4px"
          :accept="fileAccept"
          @rejected="$emit('rejected-files', $event)"
          @update:model-value="handleFilesUpdate"
        >
          <template v-slot:label>
            <span
              class="text-weight-bold"
              :class="files.length ? 'text-green-8' : 'text-deep-purple'"
            >
              {{ files.length ? "当前加载文件" : "点此选择文件" }}
            </span>
          </template>
          <template v-slot:selected>
            <q-chip
              v-if="selectedFile"
              class="q-ma-xs"
              color="primary"
              text-color="white"
            >
              <q-avatar>
                <q-icon :name="getFileIcon(selectedFile)" />
              </q-avatar>
              {{ selectedFile.name }}
              <q-tooltip>
                {{ selectedFile.name }} ({{ (selectedFile.size / 1024).toFixed(2) }} KB)
              </q-tooltip>
            </q-chip>
          </template>
          <template v-slot:append>
            <q-btn
              round
              dense
              flat
              icon="add"
              @click.stop="$refs.fileInput.pickFiles()"
            />
          </template>
        </q-file> -->
        <moonshine-file
          ref="fileInput"
          v-model="localFiles"
          :accept="fileAccept"
          :multiple="true"
          label="选择文件"
          color="primary"
          class="full-width"
          @rejected="$emit('rejected-files', $event)"
          @update:model-value="handleFilesUpdate"
        />
      </q-toolbar>

      <q-toolbar class="col-8 bg-deep-purple-2 text-white">
        <q-space />
        <div class="row full-width justify-end">
          <div class="col-12 row justify-around items-center">
            <!-- 动态工具栏按钮 -->
            <template v-if="currentModel === 'lama'">
              <!-- Lama模型工具栏 -->
              <q-btn
                flat
                :icon="showMaskTools ? 'edit_off' : 'edit'"
                :color="showMaskTools ? 'primary' : 'white'"
                :label="
                  $q.screen.gt.sm
                    ? showMaskTools
                      ? '停止绘制'
                      : '开始绘制'
                    : ''
                "
                @click="$emit('toggle-mask-tools')"
                class="col-auto"
                :disable="!selectedFile"
              >
                <q-tooltip v-if="!$q.screen.gt.sm">
                  {{ showMaskTools ? "隐藏绘制工具" : "显示绘制工具" }}
                </q-tooltip>
              </q-btn>

              <q-btn
                flat
                icon="compare"
                color="primary"
                :label="$q.screen.gt.sm ? '对比原图' : ''"
                class="col-auto"
                :disable="!selectedFile || !hasProcessedImages"
                @mousedown="$emit('show-original')"
                @mouseup="$emit('show-processed')"
                @mouseleave="$emit('show-processed')"
              >
                <q-tooltip v-if="!$q.screen.gt.sm">对比原图</q-tooltip>
              </q-btn>

              <q-btn
                flat
                icon="undo"
                color="primary"
                :label="$q.screen.gt.sm ? '撤销处理' : ''"
                class="col-auto"
                :disable="!selectedFile || !hasProcessedImages"
                @click="$emit('undo-processing')"
              >
                <q-tooltip v-if="!$q.screen.gt.sm">撤销处理</q-tooltip>
              </q-btn>
            </template>

            <template v-else-if="currentModel === 'ocr'">
              <!-- OCR模型工具栏 -->
              <q-btn
                flat
                icon="text_fields"
                color="primary"
                :label="$q.screen.gt.sm ? '识别文字' : ''"
                class="col-auto"
                :disable="!selectedFile"
                @click="$emit('recognize-text')"
              >
                <q-tooltip v-if="!$q.screen.gt.sm">识别文字</q-tooltip>
              </q-btn>

              <q-btn
                flat
                icon="content_copy"
                color="primary"
                :label="$q.screen.gt.sm ? '复制文字' : ''"
                class="col-auto"
                :disable="!hasRecognizedText"
                @click="$emit('copy-text')"
              >
                <q-tooltip v-if="!$q.screen.gt.sm">复制文字</q-tooltip>
              </q-btn>
            </template>

            <!-- 通用按钮 -->
            <q-btn
              flat
              icon="play_arrow"
              color="primary"
              :label="$q.screen.gt.sm ? '运行' : ''"
              class="col-auto"
              :disable="!selectedFile"
              @click="$emit('run-model')"
            >
              <q-tooltip v-if="!$q.screen.gt.sm">运行</q-tooltip>
            </q-btn>

            <q-btn
              flat
              icon="download"
              color="primary"
              :label="$q.screen.gt.sm ? '下载' : ''"
              class="col-auto"
              :disable="!selectedFile"
              @click="$emit('download')"
            >
              <q-tooltip v-if="!$q.screen.gt.sm">下载</q-tooltip>
            </q-btn>

            <q-btn
              flat
              icon="more_vert"
              color="primary"
              class="col-auto"
              @click="$emit('toggle-settings')"
            >
              <q-tooltip>设置面板</q-tooltip>
            </q-btn>
          </div>
        </div>
      </q-toolbar>
    </div>
  </q-footer>
</template>

<script setup>
import { computed, ref, watch } from "vue";
import { useQuasar } from "quasar";
import MoonshineFile from "./MoonshineFile.vue";

const $q = useQuasar();

const props = defineProps({
  files: {
    type: Array,
    default: () => [],
  },
  selectedFile: {
    type: Object,
    default: null,
  },
  currentModel: {
    type: String,
    default: "lama",
  },
  showMaskTools: {
    type: Boolean,
    default: false,
  },
  hasProcessedImages: {
    type: Boolean,
    default: false,
  },
  hasRecognizedText: {
    type: Boolean,
    default: false,
  },
  type: {
    type: String,
    default: "image",
  },
});

const emit = defineEmits([
  "toggle-file-explorer",
  "rejected-files",
  "update:files",
  "toggle-mask-tools",
  "show-original",
  "show-processed",
  "undo-processing",
  "recognize-text",
  "copy-text",
  "run-model",
  "download",
  "toggle-settings",
]);

// 本地文件状态
const localFiles = ref([]);

const fileAccept = computed(() => {
  return props.type === "video"
    ? ".mp4,.avi,.mov,.mkv"
    : ".png,.jpg,.jpeg,.webp";
});

// 监听 props.files 变化，同步到本地状态
watch(
  () => props.files,
  (newFiles) => {
    localFiles.value = newFiles;
  },
  { immediate: true }
);

// 处理文件更新
// const handleFilesUpdate = (newFiles) => {
//   localFiles.value = newFiles
//   emit('update:files', newFiles)
// }

// 处理文件更新
const handleFilesUpdate = (newFiles) => {
  // 确保文件对象包含路径信息
  const processedFiles = newFiles.map((file) => {
    if (!Object.prototype.hasOwnProperty.call(file, "path")) {
      Object.defineProperty(file, "path", {
        value: file.webkitRelativePath || "",
        writable: false,
      });
    }
    return file;
  });
  localFiles.value = processedFiles;
  emit("update:files", processedFiles);
};
// const getFileIcon = (file) => {
//   const type = file.type?.split('/')[0] || ''
//   return {
//     image: 'photo',
//     video: 'movie',
//     audio: 'music_note',
//     text: 'description',
//     application: 'insert_drive_file'
//   }[type] || 'insert_drive_file'
// }
</script>
