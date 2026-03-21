<template>
  <div class="resource-manage">
    <VideoUploaderButton />

    <div v-if="videoStore.hasVideoFile" class="q-mt-md">
      <q-tabs
        v-model="tab"
        dense
        align="justify"
        active-color="primary"
        indicator-color="primary"
      >
        <q-tab name="info" label="视频信息" />
        <q-tab name="masks" label="蒙版与导出" />
      </q-tabs>

      <q-separator class="q-my-sm" />

      <q-tab-panels v-model="tab" animated class="bg-transparent">
        <q-tab-panel name="info" class="q-pa-none">
          <div class="info-grid">
            <div class="info-item">
              <span class="label">文件名</span>
              <span class="value ellipsis">{{ videoInfo?.name || "-" }}</span>
            </div>
            <div class="info-item">
              <span class="label">时长</span>
              <span class="value">{{ durationText }}</span>
            </div>
            <div class="info-item">
              <span class="label">原始分辨率</span>
              <span class="value">{{ exportSizeText }}</span>
            </div>
            <div class="info-item">
              <span class="label">预览分辨率</span>
              <span class="value">{{ proxySizeText }}</span>
            </div>
            <div class="info-item">
              <span class="label">文件大小</span>
              <span class="value">{{ fileSizeText }}</span>
            </div>
            <div class="info-item">
              <span class="label">每批帧数</span>
              <span class="value">{{ computedBatchSize || "-" }}</span>
            </div>
            <div class="info-item">
              <span class="label">当前来源</span>
              <span class="value">
                {{ videoStore.currentSourceIsReplacement ? "替换后视频" : "原始上传视频" }}
              </span>
            </div>
          </div>
        </q-tab-panel>

        <q-tab-panel name="masks" class="q-pa-none">
          <div class="row q-col-gutter-sm q-mb-sm">
            <div class="col-12">
              <q-btn
                color="primary"
                icon="add"
                label="新建蒙版"
                class="full-width"
                :disable="isProcessing"
                @click="createMask"
              />
            </div>
          </div>

          <q-list bordered separator class="mask-list">
            <q-item
              v-for="mask in videoStore.masks"
              :key="mask.id"
              clickable
              :active="mask.id === videoStore.selectedMaskId"
              active-class="mask-item-active"
              @click="videoStore.selectMask(mask.id)"
            >
              <q-item-section>
                <q-item-label>{{ mask.name }}</q-item-label>
                <q-item-label caption>
                  {{ formatSeconds(mask.startTime) }} - {{ formatSeconds(mask.endTime) }}
                </q-item-label>
              </q-item-section>

              <q-item-section side>
                <q-btn
                  flat
                  round
                  dense
                  icon="delete"
                  color="negative"
                  :disable="isProcessing"
                  @click.stop="videoStore.removeMask(mask.id)"
                />
              </q-item-section>
            </q-item>

            <q-item v-if="videoStore.masks.length === 0">
              <q-item-section class="text-grey-6">
                还没有蒙版，先创建一个蒙版开始编辑。
              </q-item-section>
            </q-item>
          </q-list>

          <q-separator class="q-my-md" />

          <q-select
            :model-value="exportFpsMode"
            :options="fpsOptions"
            emit-value
            map-options
            label="导出帧率"
            :disable="isProcessing"
            @update:model-value="emit('update:exportFpsMode', $event)"
          />

          <div
            v-if="processingSucceeded && lastOutputPath"
            class="result-status text-positive text-weight-medium q-mt-md"
          >
            处理完成
          </div>

          <div v-if="processingMessage" class="text-caption q-mt-sm text-grey-7">
            {{ processingMessage }}
          </div>

          <div ref="actionButtonsRef" class="action-buttons-row q-pt-md">
            <q-btn
              color="primary"
              icon="play_arrow"
              :label="actionButtonMode === 'icon' ? undefined : runButtonLabel"
              :disable="!canRun || isProcessing"
              :loading="isProcessing"
              :class="[
                'action-button',
                'action-button-primary',
                { 'action-button-icon-only': actionButtonMode === 'icon' },
              ]"
              @click="emit('run')"
            >
              <q-tooltip>运行处理</q-tooltip>
            </q-btn>

            <q-btn
              flat
              color="primary"
              icon="folder_open"
              :label="actionButtonMode === 'icon' ? undefined : openButtonLabel"
              :disable="!lastOutputPath"
              :class="['action-button', { 'action-button-icon-only': actionButtonMode === 'icon' }]"
              @click="emit('open-output')"
            >
              <q-tooltip>打开目录</q-tooltip>
            </q-btn>
          </div>

          <div class="row q-col-gutter-sm q-mt-sm">
            <div class="col-12">
              <q-btn
                outline
                color="primary"
                icon="swap_horiz"
                label="替换当前视频源文件"
                class="full-width"
                :disable="!canReplaceSource || isProcessing"
                @click="emit('replace-source')"
              />
            </div>
            <div class="col-12" v-if="canRollbackHistory">
              <q-btn
                outline
                color="secondary"
                icon="history"
                label="回退到历史记录"
                class="full-width"
                :disable="isProcessing"
                @click="showHistoryDialog = true"
              />
            </div>
          </div>

          <q-input
            v-if="lastOutputPath"
            :model-value="lastOutputPath"
            readonly
            label="最近输出文件"
            class="q-mt-md"
          />
        </q-tab-panel>
      </q-tab-panels>
    </div>

    <q-dialog v-model="showHistoryDialog">
      <q-card class="history-dialog-card">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6">视频历史记录</div>
          <q-space />
          <q-btn icon="close" flat round dense v-close-popup />
        </q-card-section>

        <q-card-section class="history-list-wrap">
          <q-list bordered separator>
            <q-item v-for="entry in historyEntries" :key="entry.id" class="history-item">
              <q-item-section>
                <q-item-label class="row items-center q-gutter-sm no-wrap">
                  <span class="ellipsis">{{ entry.fileName || entry.label || "历史记录" }}</span>
                  <q-chip
                    dense
                    square
                    size="sm"
                    :color="entry.isReplacement ? 'secondary' : 'grey-6'"
                    text-color="white"
                  >
                    {{ entry.isReplacement ? "替换" : "原始" }}
                  </q-chip>
                </q-item-label>
                <q-item-label caption class="ellipsis">
                  {{ formatHistoryTime(entry.createdAt) }}
                </q-item-label>
                <q-item-label caption class="ellipsis">
                  {{ entry.filePath || "当前会话内文件对象" }}
                </q-item-label>
              </q-item-section>

              <q-item-section side>
                <q-btn color="primary" unelevated label="回退至此" @click="restoreHistory(entry.id)" />
              </q-item-section>
            </q-item>

            <q-item v-if="historyEntries.length === 0">
              <q-item-section class="text-grey-6">
                当前没有可回退的历史记录。
              </q-item-section>
            </q-item>
          </q-list>
        </q-card-section>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from "vue";

import { useVideoManagerStore } from "src/stores/videoManager";
import { formatSeconds } from "src/utils/videoMaskUtils";

import VideoUploaderButton from "./VideoUploaderButton.vue";

defineProps({
  exportFpsMode: {
    type: String,
    default: "source",
  },
  fpsOptions: {
    type: Array,
    default: () => [],
  },
  proxySizeText: {
    type: String,
    default: "-",
  },
  exportSizeText: {
    type: String,
    default: "-",
  },
  computedBatchSize: {
    type: Number,
    default: 0,
  },
  canRun: {
    type: Boolean,
    default: false,
  },
  isProcessing: {
    type: Boolean,
    default: false,
  },
  processingProgress: {
    type: Number,
    default: 0,
  },
  processingMessage: {
    type: String,
    default: "",
  },
  lastOutputPath: {
    type: String,
    default: "",
  },
  processingSucceeded: {
    type: Boolean,
    default: false,
  },
  canReplaceSource: {
    type: Boolean,
    default: false,
  },
  canRollbackHistory: {
    type: Boolean,
    default: false,
  },
  historyEntries: {
    type: Array,
    default: () => [],
  },
});

const emit = defineEmits([
  "update:exportFpsMode",
  "run",
  "open-output",
  "replace-source",
  "restore-history",
]);

const videoStore = useVideoManagerStore();
const tab = ref("info");
const showHistoryDialog = ref(false);
const actionButtonsRef = ref(null);
const actionButtonMode = ref("full");
let actionButtonsObserver = null;

const FULL_ACTION_WIDTH = 252;
const SHORT_ACTION_WIDTH = 176;

const videoInfo = computed(() => videoStore.getVideoFileInfo());
const durationText = computed(() => formatSeconds(videoStore.videoDuration));
const fileSizeText = computed(() => {
  const size = Number(videoInfo.value?.size || 0);
  if (!size) return "-";

  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
  return `${(size / 1024 ** index).toFixed(2)} ${units[index]}`;
});
const runButtonLabel = computed(() =>
  actionButtonMode.value === "full" ? "运行处理" : "运行"
);
const openButtonLabel = computed(() =>
  actionButtonMode.value === "full" ? "打开目录" : "打开"
);

const disconnectActionButtonsObserver = () => {
  if (!actionButtonsObserver) return;
  actionButtonsObserver.disconnect();
  actionButtonsObserver = null;
};

const updateActionButtonMode = () => {
  const width = actionButtonsRef.value?.clientWidth || 0;
  if (width >= FULL_ACTION_WIDTH) {
    actionButtonMode.value = "full";
    return;
  }
  if (width >= SHORT_ACTION_WIDTH) {
    actionButtonMode.value = "short";
    return;
  }
  actionButtonMode.value = "icon";
};

const createMask = () => {
  videoStore.createMask({
    startTime: 0,
    endTime: videoStore.videoDuration,
  });
};

const formatHistoryTime = (timestamp) => {
  if (!timestamp) return "-";
  return new Date(timestamp).toLocaleString();
};

const restoreHistory = (entryId) => {
  showHistoryDialog.value = false;
  emit("restore-history", entryId);
};

watch(
  actionButtonsRef,
  async (element) => {
    disconnectActionButtonsObserver();
    await nextTick();
    updateActionButtonMode();

    if (!element || typeof ResizeObserver === "undefined") return;

    actionButtonsObserver = new ResizeObserver(() => {
      updateActionButtonMode();
    });
    actionButtonsObserver.observe(element);
  },
  {
    flush: "post",
  }
);

watch(
  () => videoStore.hasVideoFile,
  async () => {
    await nextTick();
    updateActionButtonMode();
  }
);

onUnmounted(() => {
  disconnectActionButtonsObserver();
});
</script>

<style scoped>
.resource-manage {
  display: flex;
  flex-direction: column;
}

.info-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
}

.info-item {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
}

.label {
  color: #6b7280;
}

.value {
  color: #111827;
  text-align: right;
}

.mask-list {
  max-height: 280px;
  overflow: auto;
}

.mask-item-active {
  background: rgba(25, 118, 210, 0.1);
}

.result-status {
  font-size: 14px;
}

.action-buttons-row {
  display: flex;
  align-items: stretch;
  gap: 8px;
  flex-wrap: nowrap;
  min-width: 0;
}

.action-button {
  flex: 1 1 0;
  min-width: 0;
}

.action-button-icon-only {
  flex: 0 0 auto;
  min-width: 40px;
}

.action-button-primary {
  min-width: 0;
}

.history-dialog-card {
  width: min(720px, calc(100vw - 32px));
  max-width: 720px;
}

.history-list-wrap {
  max-height: min(60vh, 560px);
  overflow: auto;
}

.history-item {
  align-items: center;
}
</style>
