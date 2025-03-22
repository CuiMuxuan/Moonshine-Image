<template>
  <q-page class="w-full h-screen flex items-center justify-center">
    <div
      v-if="selectedFile"
      class="w-full h-full flex items-center justify-center relative"
    >
      <ImageEditor
        v-if="selectedFile.type.startsWith('image/')"
        ref="editorRef"
        :selected-file="selectedFile"
        :show-masker="showMaskTools"
        :mask="currentMask"
        :image-url="fileUrl"
        class="w-full h-full"
        @loaded="handleImageLoaded"
        @update:mask="handleMaskUpdate"
      />
      <div v-else class="w-full h-full flex items-center justify-center">
        <q-spinner-dots color="primary" size="40px" />
      </div>
    </div>
    <div
      v-else
      class="w-full h-full flex flex-col items-center justify-center text-grey-6"
    >
    <div class="column items-center">
      <!-- Logo 和声明标题的容器 -->
      <div class="column items-center q-mb-xl" style="position: relative; width: 150px; height: 150px;">
        <!-- Logo -->
        <q-img
          :src="getImagePath('moonshine128x128.jpg')"
          style="width: 128px; height: 128px; border-radius: 50%"
          class="q-mb-sm"
        />

        <!-- 声明标题 - 定位在LOGO下方并部分遮挡 -->
        <div
          class="text-h5 text-negative text-weight-bold"
          style="position: absolute; bottom: 10px; width: 100%; text-align: center; background-color: rgba(255,255,255,0.6); padding: 2px 15px; border-radius: 4px; z-index: 10;"
        >
          声明
        </div>
      </div>

      <!-- 免责声明内容 -->
      <q-card dark class="disclaimer-card q-pa-md" style="max-width: 800px; max-height: 60vh; overflow-y: auto">
        <q-card-section>
          <div class="text-warning">
            <p>1.使用者对本项目的使用由使用者自行决定，并自行承担风险。作者对使用者使用本项目所产生的任何损失、责任、或风险概不负责。</p>
            <p>2.本项目的作者提供的代码和功能是基于现有知识和技术开发的成果。作者尽力确保代码的正确性和安全性，但不保证代码完全没有错误或缺陷。</p>
            <p>3.使用者在使用本项目时必须严格遵守GNU General Public License v3.0的要求，并在适当的地方注明使用了GPLv3的代码。</p>
            <p>4.使用者在任何情况下均不得将本项目的作者、贡献者或其他相关方与使用者的使用行为联系起来，或要求其对使用者使用本项目所产生的任何损失或损害负责。</p>
            <p>5.使用者在使用本项目的代码和功能时，必须自行研究相关法律法规，并确保其使用行为合法合规。任何因违反法律法规而导致的法律责任和风险，均由使用者自行承担。</p>
            <p class="text-negative">6.本项目为基于GPLv3协议的开源项目，作者不会提供本项目的付费版本。</p>
            <p>7.基于本项目进行的任何二次开发、修改或编译的程序与原创作者无关，原创作者不承担与二次开发行为或其结果相关的任何责任，使用者应自行对因二次开发可能带来的各种情况负全部责任。</p>
            <p>在使用本项目的代码和功能之前，请您认真考虑并接受以上免责声明。</p>
            <p>如果您对上述声明有任何疑问或不同意，请不要使用本项目的代码和功能。</p>
            <p>如果您使用了本项目的代码和功能，则视为您已完全理解并接受上述免责声明，并自愿承担使用本项目的一切风险和后果。</p>
          </div>
        </q-card-section>
      </q-card>
    </div>
  </div>
  </q-page>
</template>

<script setup>
import { ref, watch, provide, onMounted } from "vue";
import ImageEditor from "../components/ImageEditor.vue";

const editorRef = ref(null);
const isImageLoaded = ref(false);
const isElectron = ref(false);
const resourcesPath = ref('');

const props = defineProps({
  selectedFile: {
    type: Object,
    default: null,
  },
  showMaskTools: {
    type: Boolean,
    default: true,
  },
  currentMask: {
    type: Object,
    default: null
  },
  fileUrl: {
    type: String,
    default: null
  }
});

// 提供编辑器引用
provide('editor-ref', editorRef);
// 获取图片路径的函数
const getImagePath = (imageName) => {
  if (isElectron.value && process.env.NODE_ENV === 'production') {
    // 生产环境 - Electron
    if (resourcesPath.value) {
      // 使用正确的路径分隔符
      return `${resourcesPath.value.replace(/\\/g, '/')}/public/images/${imageName}`;
    } else {
      // 备选路径
      return `./resources/public/images/${imageName}`;
    }
  } else {
    // 开发环境或浏览器环境
    return `/images/${imageName}`;
  }
};
watch(
  () => props.selectedFile,
  (file) => {
    if (file && file.type.startsWith('image/')) {
      isImageLoaded.value = false;
    }
  },
  { immediate: true }
);

// 处理图片加载完成事件
const handleImageLoaded = () => {
  isImageLoaded.value = true;
};
// 处理蒙版更新
const handleMaskUpdate = (maskData) => {
  if (props.selectedFile) {
    // 通知父组件更新蒙版
    emit('update:mask', props.selectedFile.name, maskData);
  }
};

const emit = defineEmits(['update:mask']);
provide("image-editor", editorRef);

onMounted(async () => {
  // 检测是否在 Electron 环境中
  isElectron.value = !!window.electron;

  // 如果在 Electron 环境中，获取资源路径
  if (isElectron.value && window.electron) {
    try {
      // 使用 IPC 从主进程获取资源路径
      if (window.electron.ipcRenderer && window.electron.ipcRenderer.invoke) {
        resourcesPath.value = await window.electron.ipcRenderer.invoke('get-resources-path');
      } else {
        // 备选路径
        resourcesPath.value = './resources';
      }
    } catch (error) {
      console.error('获取资源路径失败:', error);
      resourcesPath.value = './resources';
    }
  }
});
</script>

<style scoped>
.disclaimer-card {
  border-radius: 8px;
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
}

.disclaimer-card p {
  margin-bottom: 12px;
  line-height: 1.5;
}
</style>