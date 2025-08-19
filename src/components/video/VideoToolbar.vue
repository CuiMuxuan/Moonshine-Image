<template>
  <div class="bg-deep-purple-2 fit">
    <q-toolbar class="justify-evenly" style="min-height: 24px; height: 100%">
      <div class="col-auto">
        <MoonshineButton
          round
          color="primary"
          icon="fast_rewind"
          anchor="top"
          tooltip-text="上一帧"
          @click="handlePreviousFrame"
          :disabled="!videoStore.hasVideoFile"
        />
      </div>
      <div class="col-auto"></div>
      <div class="col-auto">
        <MoonshineButton
          :model-value="isPlaying"
          :toggle="true"
          :disabled="!videoStore.hasVideoFile"
          round
          color="primary"
          toggle-color="negative"
          icon="play_arrow"
          toggle-icon="pause"
          anchor="top"
          tooltip-text="播放"
          toggle-tooltip-text="暂停"
          @click="handlePlayPause"
        />
      </div>
      <div class="col-auto"></div>
      <div class="col-auto">
        <MoonshineButton
          round
          color="primary"
          icon="fast_forward"
          anchor="top"
          tooltip-text="下一帧"
          @click="handleNextFrame"
          :disabled="!videoStore.hasVideoFile"
        />
      </div>
      <div class="col-auto"></div>
      <div class="col-auto">
        <q-btn-dropdown
          :label="`${videoStore.playbackRate}x`"
          color="primary"
          :size="responsiveSize"
          :disable="!videoStore.hasVideoFile"
          anchor="top"
        >
          <q-tooltip>播放倍速</q-tooltip>
          <q-list>
            <q-item
              v-for="rate in playbackRates"
              :key="rate"
              clickable
              v-close-popup
              @click="handlePlaybackRateChange(rate)"
              :class="{ 'bg-primary text-white': rate === videoStore.playbackRate }"
            >
              <q-item-section>
                <q-item-label>{{ rate }}x</q-item-label>
              </q-item-section>
            </q-item>
          </q-list>
        </q-btn-dropdown>
      </div>
    </q-toolbar>
  </div>
</template>
<script setup>
import { computed, ref, onMounted, onUnmounted } from "vue";
import MoonshineButton from "../common/MoonshineButton.vue";
import { useVideoManagerStore } from '../../stores/videoManager';

const videoStore = useVideoManagerStore();
const screenSize = ref('md');

// 播放倍速选项
const playbackRates = [0.5, 1, 1.5, 2, 3];

// 响应式大小计算 - 与MoonshineButton.vue保持一致
const responsiveSize = computed(() => {
  switch (screenSize.value) {
    case 'xs':
      return 'xs'
    case 'sm':
    case 'md':
      return 'sm'
    default:
      return 'md'
  }
});

// 更新屏幕尺寸 - 与MoonshineButton.vue保持一致
const updateScreenSize = () => {
  const width = window.innerWidth
  if (width < 600) {
    screenSize.value = 'xs'
  } else if (width < 1024) {
    screenSize.value = 'sm'
  } else if (width < 1440) {
    screenSize.value = 'md'
  } else if (width < 1920) {
    screenSize.value = 'lg'
  } else {
    screenSize.value = 'xl'
  }
};

// 定义事件
const emit = defineEmits(['play-pause', 'previous-frame', 'next-frame', 'playback-rate-change']);

// 使用videoStore中的播放状态
const isPlaying = computed(() => videoStore.isPlaying);

const handlePlayPause = () => {
  if (!videoStore.hasVideoFile) {
    console.warn('没有视频文件');
    return;
  }

  // 通过事件通知父组件
  emit('play-pause');
};

// 处理上一帧按钮点击
const handlePreviousFrame = () => {
  emit('previous-frame');
};

// 处理下一帧按钮点击
const handleNextFrame = () => {
  emit('next-frame');
};

// 处理播放倍速变化
const handlePlaybackRateChange = (rate) => {
  emit('playback-rate-change', rate);
};

// 生命周期 - 与MoonshineButton.vue保持一致
onMounted(() => {
  updateScreenSize()
  window.addEventListener('resize', updateScreenSize)
})

onUnmounted(() => {
  window.removeEventListener('resize', updateScreenSize)
})
</script>
