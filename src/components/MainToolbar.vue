<template>
  <q-toolbar>
    <q-toolbar-title>
      <q-avatar>
        <moonshine-icon color="white" :size="24" />
      </q-avatar>
      Moonshine-Image
    </q-toolbar-title>

    <!-- GitHub 图标 -->
    <q-btn flat round dense class="q-mr-sm" @click="openGithubLink">
      <q-icon name="code" />
      <q-tooltip>GitHub 仓库</q-tooltip>
    </q-btn>

    <!-- 赞助按钮 -->
    <q-btn
      flat
      round
      dense
      icon="favorite"
      class="q-mr-sm"
      @click="showSponsorDialog = true"
    >
      <q-tooltip>支持作者</q-tooltip>
    </q-btn>

    <!-- 后端管理按钮插槽 -->
    <slot name="backend"></slot>
    <!-- 设置按钮插槽 -->
    <slot name="settings"></slot>
    <!-- 赞助对话框 -->
    <q-dialog v-model="showSponsorDialog" persistent>
      <q-card class="sponsor-card" style="width: 90%; max-width: 800px">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6">感谢您的支持</div>
          <q-space />
          <q-btn icon="close" flat round dense v-close-popup />
        </q-card-section>

        <q-card-section>
          <div class="row justify-around q-mb-md">
            <div class="col-xs-12 col-sm-5 text-center q-pa-sm">
              <p class="q-mb-sm">微信支付</p>
              <q-img
                :src="getImagePath('wxPay.png')"
                style="width: 100%; max-width: 300px"
                spinner-color="primary"
                contain
              />
            </div>
            <div class="col-xs-12 col-sm-5 text-center q-pa-sm">
              <p class="q-mb-sm">支付宝</p>
              <q-img
                :src="getImagePath('Alipay.jpg')"
                style="width: 100%; max-width: 300px"
                spinner-color="primary"
                contain
              />
            </div>
          </div>

          <q-separator class="q-my-md" />

          <div class="text-center">
            <p>或者你也可以阅读作者写的免费小说</p>
            <q-btn
              color="primary"
              icon="menu_book"
              label="阅读小说"
              @click="openNovelLink"
            />
          </div>
        </q-card-section>
      </q-card>
    </q-dialog>

    <!-- 作者头像 -->
    <q-avatar class="cursor-pointer" @click="openBilibiliLink">
      <q-img :src="getImagePath('moonshine128x128.jpg')" :ratio="1" />
      <q-tooltip>作者B站</q-tooltip>
    </q-avatar>
  </q-toolbar>
</template>

<script setup>
import { ref,onMounted } from "vue";
import MoonshineIcon from "src/components/MoonshineIcon.vue";

// 赞助对话框状态
const showSponsorDialog = ref(false);

// 资源路径
const resourcesPath = ref("");

// 检查是否在 Electron 环境中
const isElectron = ref(false);
// 获取图片路径
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


// 打开 GitHub 链接
const openGithubLink = () => {
  const url = "https://github.com/CuiMuxuan/Moonshine-Image";
  if (window.electron) {
    window.electron.ipcRenderer.send("open-external-link", url);
  } else {
    window.open(url, "_blank");
  }
};

// 打开 B 站链接
const openBilibiliLink = () => {
  const url = "https://space.bilibili.com/589465087";
  if (window.electron) {
    window.electron.ipcRenderer.send("open-external-link", url);
  } else {
    window.open(url, "_blank");
  }
};

// 打开小说链接
const openNovelLink = () => {
  const url = "https://www.jjwxc.net/oneauthor.php?authorid=3292754";
  if (window.electron) {
    window.electron.ipcRenderer.send("open-external-link", url);
  } else {
    window.open(url, "_blank");
  }
};

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
