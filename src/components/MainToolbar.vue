<template>
  <q-toolbar>
    <q-toolbar-title class="toolbar-title">
      <q-avatar>
        <moonshine-icon color="white" :size="24" />
      </q-avatar>
      <span class="app-name">Moonshine-Image</span>
    </q-toolbar-title>
    <!-- 导航按钮 -->
    <div class="navigation-buttons q-mx-md">
      <q-btn
        :flat="currentRoute !== 'image'"
        :unelevated="currentRoute === 'image'"
        :color="currentRoute === 'image' ? 'white' : 'primary'"
        :text-color="currentRoute === 'image' ? 'primary' : 'white'"
        class="nav-btn q-mr-xs"
        @click="handleRouteChange('image')"
      >
        <q-icon name="image" class="nav-icon" />
        <span class="nav-text">图片处理</span>
      </q-btn>

      <q-btn
        :flat="currentRoute !== 'video'"
        :unelevated="currentRoute === 'video'"
        :color="currentRoute === 'video' ? 'white' : 'primary'"
        :text-color="currentRoute === 'video' ? 'primary' : 'white'"
        class="nav-btn"
        @click="handleRouteChange('video')"
      >
        <q-icon name="videocam" class="nav-icon" />
        <span class="nav-text">视频处理</span>
      </q-btn>
    </div>
    <q-space />
    <!-- GitHub 图标 -->
    <q-btn flat round dense class="q-mr-sm" @click="openGithubLink">
      <q-icon name="code" />
      <q-tooltip class="toolbar-tooltip">GitHub 仓库</q-tooltip>
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
      <q-tooltip class="toolbar-tooltip">支持作者</q-tooltip>
    </q-btn>

    <!-- 后端管理按钮插槽 -->
    <slot name="backend"></slot>
    <!-- 设置按钮插槽 -->
    <slot name="settings"></slot>
    <!-- 赞助对话框 -->
    <q-dialog v-model="showSponsorDialog" persistent class="sponsor-dialog">
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
      <q-tooltip class="toolbar-tooltip">作者B站</q-tooltip>
    </q-avatar>
  </q-toolbar>
</template>

<script setup>
import { ref, onMounted, watch } from "vue";
import { useRoute } from "vue-router";
import MoonshineIcon from "src/components/MoonshineIcon.vue";

const route = useRoute();
const emit = defineEmits(["route-change"]);
// 赞助对话框状态
const showSponsorDialog = ref(false);

// 资源路径
const resourcesPath = ref("");

// 检查是否在 Electron 环境中
const isElectron = ref(false);
// 当前路由
const currentRoute = ref("image");
// 监听路由变化，更新当前选中的导航
watch(
  () => route.path,
  (newPath) => {
    if (newPath.includes("/video")) {
      currentRoute.value = "video";
    } else {
      currentRoute.value = "image";
    }
  },
  { immediate: true }
);
// 处理导航切换
const handleRouteChange = (value) => {
  emit("route-change", value);
};
// 获取图片路径
const getImagePath = (imageName) => {
  if (isElectron.value && process.env.NODE_ENV === "production") {
    // 生产环境 - Electron
    if (resourcesPath.value) {
      // 使用正确的路径分隔符
      return `${resourcesPath.value.replace(
        /\\/g,
        "/"
      )}/public/images/${imageName}`;
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
        resourcesPath.value = await window.electron.ipcRenderer.invoke(
          "get-resources-path"
        );
      } else {
        // 备选路径
        resourcesPath.value = "./resources";
      }
    } catch (error) {
      console.error("获取资源路径失败:", error);
      resourcesPath.value = "./resources";
    }
  }
});
</script>
<style scoped>
/* 工具栏标题响应式设计 */
.toolbar-title {
  max-width: 260px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.app-name {
  transition: opacity 0.3s ease;
}

/* 导航按钮样式 */
.navigation-buttons {
  display: flex;
  align-items: center;
}

.nav-btn {
  border-radius: 8px;
  padding: 8px 16px;
  transition: all 0.3s ease;
  min-width: 120px;
}

.nav-icon {
  margin-right: 8px;
  font-size: 18px;
}

.nav-text {
  font-weight: 500;
  transition: opacity 0.3s ease;
}

/* 响应式设计 */
@media (max-width: 768px) {
  .app-name {
    display: none;
  }

  .nav-btn {
    min-width: 48px;
    padding: 8px;
  }

  .nav-text {
    display: none;
  }

  .nav-icon {
    margin-right: 0;
  }
}

@media (max-width: 600px) {
  .navigation-buttons {
    gap: 4px;
  }
}

/* 赞助对话框层级 - 最高层级 */
:deep(.sponsor-dialog .q-dialog) {
  z-index: 3000 !important;
}

:deep(.sponsor-dialog .q-dialog__backdrop) {
  z-index: 3000 !important;
}

/* 工具栏tooltip层级 */
:deep(.toolbar-tooltip) {
  z-index: 2100 !important;
}
</style>
