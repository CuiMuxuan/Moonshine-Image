<template>
  <q-page class="flex">
    <!-- 页面禁用覆盖层 -->
    <div
      v-if="isPageDisabled"
      class="page-disabled-overlay"
      @click.stop.prevent
      @mousedown.stop.prevent
      @mouseup.stop.prevent
      @keydown.stop.prevent
      @keyup.stop.prevent
    ></div>

    <!-- 左侧蒙版浏览器 -->
    <q-drawer
      v-model="leftDrawerOpen"
      show-if-above
      bordered
      :width="300"
      :breakpoint="500"
    >
      <div class="q-pa-md" :class="{ 'pointer-events-none': isPageDisabled }">
        <div class="text-h6 q-mb-md flex items-center">
          <q-icon name="layers" class="q-mr-sm" />
          蒙版管理
        </div>
        <MaskBrowser
          :masks="videoStore.masks"
          :active-mask-id="videoStore.activeMaskId"
          :current-frame="videoStore.currentFrame"
          @select-mask="handleMaskSelect"
          @add-mask="handleAddMask"
          @delete-mask="handleDeleteMask"
        />
      </div>
    </q-drawer>

    <!-- 右侧配置面板 -->
    <q-drawer
      v-model="rightDrawerOpen"
      show-if-above
      side="right"
      bordered
      :width="350"
    >
      <div class="q-pa-md" :class="{ 'pointer-events-none': isPageDisabled }">
        <div class="text-h6 q-mb-md flex items-center">
          <q-icon name="settings" class="q-mr-sm" />
          处理设置
        </div>
        <div>视频处理功能作者正在研究中，暂不可用</div>
        <!-- 模型选择器 -->
        <q-item>
          <q-item-section>
            <model-selector
              v-model="currentModel"
              type="video"
              @update:model-value="handleModelChange"
            />
          </q-item-section>
        </q-item>

        <!-- 视频处理配置 -->
        <q-list>
          <q-item>
            <q-item-section>
              <q-input
                v-model.number="videoStore.processingConfig.quality"
                type="number"
                label="视频质量 (CRF)"
                :min="0"
                :max="51"
                filled
                hint="数值越小质量越高，推荐18-28"
              />
            </q-item-section>
          </q-item>

          <q-item>
            <q-item-section>
              <q-select
                v-model="videoStore.processingConfig.video_codec"
                :options="videoCodecOptions"
                label="视频编码"
                filled
              />
            </q-item-section>
          </q-item>

          <q-item>
            <q-item-section>
              <q-toggle
                v-model="videoStore.processingConfig.preserve_audio"
                label="保留音频"
              />
            </q-item-section>
          </q-item>

          <q-item v-if="videoStore.processingConfig.preserve_audio">
            <q-item-section>
              <q-select
                v-model="videoStore.processingConfig.audio_codec"
                :options="audioCodecOptions"
                label="音频编码"
                filled
              />
            </q-item-section>
          </q-item>

          <q-item>
            <q-item-section>
              <q-input
                v-model.number="videoStore.processingConfig.max_workers"
                type="number"
                label="并行处理数"
                :min="1"
                :max="8"
                filled
                hint="根据CPU核心数调整"
              />
            </q-item-section>
          </q-item>

          <q-item>
            <q-item-section>
              <folder-selector v-model="outputPath" label="输出路径" />
            </q-item-section>
          </q-item>

          <q-item>
            <q-item-section>
              <cuda-status
                @cuda-status-changed="handleCudaStatusChanged"
                :backend-running="backendRunning"
              />
            </q-item-section>
          </q-item>
        </q-list>

        <!-- 蒙版配置 -->
        <div v-if="videoStore.activeMask" class="q-mt-lg">
          <MaskConfiguration
            :mask="videoStore.activeMask"
            :video-info="videoStore.videoInfo"
            :current-frame="videoStore.currentFrame"
            @update-mask="handleMaskUpdate"
            @add-offset="handleAddOffset"
            @remove-offset="handleRemoveOffset"
          />
        </div>
      </div>
    </q-drawer>

    <!-- 主工作区 -->
    <div class="col flex column">
      <!-- 视频播放器/编辑器 -->
      <div class="col">
        <workspace
          :selected-file="currentVideo"
          :class="{ 'pointer-events-none': isPageDisabled }"
        >
          <div v-if="currentVideo" class="video-workspace">
            <!-- 视频播放器 -->
            <div v-if="!isEditingMask" class="video-player-container">
              <video
                ref="videoPlayerRef"
                :src="currentVideoUrl"
                class="video-player"
                @loadedmetadata="handleVideoLoaded"
                @timeupdate="handleTimeUpdate"
                @seeked="handleSeeked"
                controls
              />
            </div>

            <!-- 蒙版编辑器 -->
            <VideoMaskEditor
              v-else
              :video-file="currentVideo"
              :current-frame="videoStore.currentFrame"
              :video-info="videoStore.videoInfo"
              @mask-saved="handleMaskSaved"
              @mask-deleted="handleMaskDeleted"
              @edit-mode-change="handleEditModeChange"
            />
          </div>

          <!-- 空状态 -->
          <div v-else class="empty-state">
            <q-icon name="video_library" size="64px" color="grey-5" />
            <p class="text-grey-6 q-mt-md">请上传视频文件开始处理</p>
          </div>
        </workspace>
      </div>

      <!-- 底部时间轴 -->
      <div v-if="currentVideo" class="timeline-container">
        <VideoTimeline
          :video-info="videoStore.videoInfo"
          :current-frame="videoStore.currentFrame"
          :masks="videoStore.masks"
          :active-mask-id="videoStore.activeMaskId"
          @seek-to-frame="handleSeekToFrame"
          @select-mask="handleMaskSelect"
        />
      </div>

      <!-- 底部工具栏 -->
      <VideoProcessingToolbar
        :current-video="currentVideo"
        :current-model="currentModel"
        :is-editing-mask="isEditingMask"
        :is-processing="videoStore.isProcessing"
        :has-processed-video="hasProcessedVideo"
        :can-undo="canUndo"
        :can-redo="canRedo"
        :class="{ 'pointer-events-none': isPageDisabled }"
        @toggle-file-explorer="leftDrawerOpen = !leftDrawerOpen"
        @toggle-settings="rightDrawerOpen = !rightDrawerOpen"
        @upload-video="handleUploadVideo"
        @toggle-mask-editor="toggleMaskEditor"
        @start-processing="startVideoProcessing"
        @stop-processing="stopVideoProcessing"
        @download-video="downloadProcessedVideo"
        @undo="undo"
        @redo="redo"
      />
    </div>

    <!-- 处理进度对话框 -->
    <q-dialog v-model="showProgressDialog" persistent>
      <q-card style="min-width: 400px">
        <q-card-section>
          <div class="text-h6">视频处理中...</div>
        </q-card-section>

        <q-card-section>
          <div class="q-mb-sm">{{ videoStore.processingProgress.stage }}</div>
          <q-linear-progress
            :value="videoStore.processingProgress.progress / 100"
            color="primary"
            size="20px"
            class="q-mb-sm"
          >
            <div class="absolute-full flex flex-center">
              <q-badge
                color="white"
                text-color="primary"
                :label="`${videoStore.processingProgress.progress}%`"
              />
            </div>
          </q-linear-progress>
          <div class="text-caption text-grey-6">
            {{ videoStore.processingProgress.details }}
          </div>
        </q-card-section>

        <q-card-actions align="right">
          <q-btn
            flat
            label="取消"
            color="negative"
            @click="cancelVideoProcessing"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup>
import {
  ref,
  computed,
  watch,
  onMounted,
  onUnmounted
} from "vue";
import { useQuasar } from "quasar";
import { useVideoProcessingStore } from "src/stores/videoProcessing";
import { useConfigStore } from "src/stores/config";
import VideoMaskEditor from "../components/VideoMaskEditor.vue";
import MaskBrowser from "../components/MaskBrowser.vue";
import MaskConfiguration from "../components/MaskConfiguration.vue";
import VideoTimeline from "../components/VideoTimeline.vue";
import VideoProcessingToolbar from "../components/VideoProcessingToolbar.vue";
import Workspace from "../components/Workspace.vue";
import ModelSelector from "../components/ModelSelector.vue";
import FolderSelector from "../components/FolderSelector.vue";
import CudaStatus from "../components/CudaStatus.vue";

const $q = useQuasar();
const videoStore = useVideoProcessingStore();
const configStore = useConfigStore();

// UI状态
const leftDrawerOpen = ref(false);
const rightDrawerOpen = ref(false);
const isEditingMask = ref(false);
const showProgressDialog = ref(false);
const isPageDisabled = ref(false);

// 视频相关
const videoPlayerRef = ref(null);
const currentVideo = ref(null);
const currentModel = ref("lama");
const outputPath = ref("");

// 配置选项
const videoCodecOptions = [
  { label: "H.264 (推荐)", value: "libx264" },
  { label: "H.265", value: "libx265" },
  { label: "VP9", value: "libvpx-vp9" },
];

const audioCodecOptions = [
  { label: "AAC (推荐)", value: "aac" },
  { label: "MP3", value: "mp3" },
  { label: "Opus", value: "libopus" },
];

// 计算属性
const currentVideoUrl = computed(() => {
  if (!currentVideo.value) return null;

  // 使用atom协议直接访问文件，避免加载到内存
  if (currentVideo.value.path) {
    // 如果是文件路径
    return `atom://${currentVideo.value.path}`;
  } else if (currentVideo.value instanceof File) {
    // 如果是File对象，需要先保存到临时文件
    return createTempVideoUrl(currentVideo.value);
  }

  return null;
});

const hasProcessedVideo = computed(() => {
  return !!videoStore.processedVideoPath;
});

const canUndo = computed(() => {
  return (
    videoStore.maskHistory.length > 0 &&
    videoStore.maskHistory.some((item) => !item.saved)
  );
});

const canRedo = computed(() => {
  // TODO: 实现重做逻辑，需要在store中添加redoHistory
  return false;
});

const props = defineProps({
  backendRunning: {
    type: Boolean,
    default: false,
  },
});

const backendRunning = computed(() => props.backendRunning);

// 方法
const handleUploadVideo = () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".mp4,.avi,.mov,.mkv";
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      currentVideo.value = file;
      videoStore.loadVideo(file);
    }
  };
  input.click();
};

// 创建临时视频URL
const createTempVideoUrl = async (file) => {
  try {
    // 通过electron保存到临时文件
    const tempPath = await window.electron.ipcRenderer.invoke('save-temp-video', {
      fileName: file.name,
      buffer: await file.arrayBuffer()
    });
    return `atom://${tempPath}`;
  } catch (error) {
    console.error('创建临时视频文件失败:', error);
    // 降级到blob URL
    return URL.createObjectURL(file);
  }
};
// 清理临时文件
const cleanupTempVideo = () => {
  if (currentVideoUrl.value && currentVideoUrl.value.startsWith('atom://')) {
    const filePath = currentVideoUrl.value.replace('atom://', '');
    window.electron.ipcRenderer.invoke('cleanup-temp-file', filePath);
  }
};
const handleVideoLoaded = () => {
  const video = videoPlayerRef.value;
  if (video) {
    videoStore.videoInfo = {
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
      frameRate: 30, // 默认帧率，可以通过其他方式获取
      totalFrames: Math.floor(video.duration * 30),
    };
  }
};

const handleTimeUpdate = () => {
  const video = videoPlayerRef.value;
  if (video) {
    videoStore.currentTime = video.currentTime;
    videoStore.currentFrame = Math.floor(
      video.currentTime * videoStore.videoInfo.frameRate
    );
  }
};

const handleSeeked = () => {
  handleTimeUpdate();
};

const handleSeekToFrame = (frame) => {
  const video = videoPlayerRef.value;
  if (video && videoStore.videoInfo.frameRate > 0) {
    const time = frame / videoStore.videoInfo.frameRate;
    video.currentTime = time;
    videoStore.setCurrentFrame(frame);
  }
};

const handleModelChange = (model) => {
  currentModel.value = model;
  $q.notify({
    type: "info",
    message: `已切换到${model}模型`,
    position: "top",
  });
};

const handleCudaStatusChanged = (status) => {
  // 处理CUDA状态变化
  console.log("CUDA状态:", status);
};

// 蒙版相关方法
const handleMaskSelect = (maskId) => {
  videoStore.setActiveMask(maskId);
};

const handleAddMask = () => {
  const newMask = {
    id: Date.now(),
    name: `蒙版 ${videoStore.masks.size + 1}`,
    start_frame: videoStore.currentFrame,
    end_frame: videoStore.currentFrame + 30,
    mask_data: null,
    mask_type: "user-drawn",
    interpolate_offsets: true,
    offsets: [],
  };
  videoStore.addMask(newMask);
  isEditingMask.value = true;
};

const handleDeleteMask = (maskId) => {
  $q.dialog({
    title: "确认删除",
    message: "确定要删除这个蒙版吗？",
    cancel: true,
    persistent: true,
  }).onOk(() => {
    videoStore.deleteMask(maskId);
  });
};

const handleMaskUpdate = (updates) => {
  if (videoStore.activeMaskId) {
    videoStore.updateMask(videoStore.activeMaskId, updates);
  }
};

const handleAddOffset = (frame, offset) => {
  if (videoStore.activeMaskId) {
    videoStore.addMaskOffset(videoStore.activeMaskId, frame, offset);
  }
};

const handleRemoveOffset = (frame) => {
  if (videoStore.activeMaskId) {
    videoStore.removeMaskOffset(videoStore.activeMaskId, frame);
  }
};

const handleMaskSaved = (frame) => {
  console.log(frame);
  // TODO: 处理蒙版保存
  $q.notify({
    type: "positive",
    message: "蒙版已保存",
    position: "top",
  });
};

const handleMaskDeleted = (frame) => {
  console.log(frame);
  // TODO: 处理蒙版删除
  $q.notify({
    type: "info",
    message: "蒙版已删除",
    position: "top",
  });
};

const handleEditModeChange = (mode) => {
  // TODO:处理编辑模式变化
  console.log("编辑模式:", mode);
};

const toggleMaskEditor = () => {
  isEditingMask.value = !isEditingMask.value;
};

// 视频处理方法
const startVideoProcessing = async () => {
  if (!currentVideo.value) {
    $q.notify({
      type: "warning",
      message: "请先上传视频文件",
      position: "top",
    });
    return;
  }

  if (videoStore.masks.size === 0) {
    $q.notify({
      type: "warning",
      message: "请先添加蒙版",
      position: "top",
    });
    return;
  }

  showProgressDialog.value = true;
  isPageDisabled.value = true;

  try {
    await videoStore.processVideo();
    $q.notify({
      type: "positive",
      message: "视频处理完成",
      position: "top",
    });
  } catch (error) {
    $q.notify({
      type: "negative",
      message: `处理失败: ${error.message}`,
      position: "top",
    });
  } finally {
    showProgressDialog.value = false;
    isPageDisabled.value = false;
  }
};

const stopVideoProcessing = () => {
  videoStore.cancelProcessing();
  showProgressDialog.value = false;
  isPageDisabled.value = false;
};

const cancelVideoProcessing = () => {
  $q.dialog({
    title: "确认取消",
    message: "确定要取消视频处理吗？",
    cancel: true,
    persistent: true,
  }).onOk(() => {
    stopVideoProcessing();
  });
};

const downloadProcessedVideo = () => {
  // TODO: 实现下载逻辑
  $q.notify({
    type: "info",
    message: "下载功能开发中...",
    position: "top",
  });
};

const undo = () => {
  if (videoStore.maskHistory.length > 0) {
    const lastAction =
      videoStore.maskHistory[videoStore.maskHistory.length - 1];

    if (lastAction.type === "add") {
      videoStore.deleteMask(lastAction.maskId);
    } else if (lastAction.type === "delete") {
      videoStore.addMask(lastAction.data);
    } else if (lastAction.type === "update") {
      videoStore.updateMask(lastAction.maskId, lastAction.oldData);
    }

    // 移除历史记录
    videoStore.maskHistory.pop();

    $q.notify({
      type: "info",
      message: "已撤销上一步操作",
      position: "top",
    });
  }
};

const redo = () => {
  // TODO: 实现重做逻辑
  $q.notify({
    type: "info",
    message: "重做功能开发中...",
    position: "top",
  });
};

// 生命周期
onMounted(() => {
  // 初始化配置
  configStore.loadConfig();
});

onUnmounted(() => {
  // 清理资源
  if (currentVideoUrl.value) {
    URL.revokeObjectURL(currentVideoUrl.value);
  }
  cleanupTempVideo();
});

// 监听器
watch(
  () => videoStore.isProcessing,
  (isProcessing) => {
    if (isProcessing) {
      showProgressDialog.value = true;
      isPageDisabled.value = true;
    }
  }
);
</script>

<style scoped>
.page-disabled-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(255, 255, 255, 0.7);
  z-index: 9999;
  cursor: not-allowed;
}

.video-workspace {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.video-player-container {
  flex: 1;
  display: flex;
  justify-content: center;
  align-items: center;
  background: #000;
}

.video-player {
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
}

.timeline-container {
  border-top: 1px solid #e0e0e0;
  background: #f5f5f5;
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  color: #666;
}

.pointer-events-none {
  pointer-events: none;
}
</style>
