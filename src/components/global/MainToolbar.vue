<template>
  <q-toolbar>
    <q-toolbar-title class="toolbar-title">
      <q-avatar size="34px">
        <q-img :src="navBrandImage" :ratio="1" />
      </q-avatar>
      <span class="app-name">Moonshine-Image</span>
    </q-toolbar-title>

    <div class="navigation-buttons q-mx-md">
      <q-btn
        :flat="currentRoute !== 'image'"
        :unelevated="currentRoute === 'image'"
        :color="currentRoute === 'image' ? 'white' : 'primary'"
        :text-color="currentRoute === 'image' ? 'primary' : 'white'"
        class="nav-btn q-mr-xs"
        :disable="navigationDisabled"
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
        :disable="navigationDisabled"
        @click="handleRouteChange('video')"
      >
        <q-icon name="videocam" class="nav-icon" />
        <span class="nav-text">视频处理</span>
      </q-btn>
    </div>

    <q-space />

    <q-btn flat round dense class="q-mr-sm" @click="emit('toggle-theme')">
      <q-icon :name="themeMode === 'dark' ? 'light_mode' : 'dark_mode'" />
      <q-tooltip class="toolbar-tooltip">
        {{ themeMode === "dark" ? "切换到明亮模式" : "切换到暗黑模式" }}
      </q-tooltip>
    </q-btn>

    <q-btn flat round dense class="q-mr-sm" @click="openGithubLink">
      <q-icon name="code" />
      <q-tooltip class="toolbar-tooltip">GitHub 仓库</q-tooltip>
    </q-btn>

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

    <slot name="backend"></slot>
    <slot name="settings"></slot>

    <q-dialog v-model="showSponsorDialog" persistent class="sponsor-dialog">
      <q-card class="sponsor-card" style="width: 90%; max-width: 800px">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6">感谢你的支持</div>
          <q-space />
          <q-btn icon="close" flat round dense v-close-popup />
        </q-card-section>

        <q-card-section>
          <div class="row justify-around q-mb-md">
            <div class="col-xs-12 col-sm-5 text-center q-pa-sm">
              <p class="q-mb-sm">微信支付</p>
              <q-img :src="sponsorWechatImage" style="width: 100%; max-width: 300px" spinner-color="primary" contain />
            </div>
            <div class="col-xs-12 col-sm-5 text-center q-pa-sm">
              <p class="q-mb-sm">支付宝</p>
              <q-img :src="sponsorAlipayImage" style="width: 100%; max-width: 300px" spinner-color="primary" contain />
            </div>
          </div>

          <q-separator class="q-my-md" />

          <div class="text-center">
            <p>也可以看看作者写的免费小说。</p>
            <q-btn color="primary" icon="menu_book" label="阅读小说" @click="openNovelLink" />
          </div>
        </q-card-section>
      </q-card>
    </q-dialog>

    <q-avatar class="cursor-pointer" size="38px" @click="openBilibiliLink">
      <q-img :src="authorAvatarImage" :ratio="1" />
      <q-tooltip class="toolbar-tooltip">作者 B 站主页</q-tooltip>
    </q-avatar>
  </q-toolbar>
</template>

<script setup>
import { ref, watch } from "vue";
import { useRoute } from "vue-router";

import sponsorAlipayImage from "src/assets/branding/Alipay.jpg";
import sponsorWechatImage from "src/assets/branding/wxPay.png";
import { resolvePublicAssetPath } from "src/utils/publicAsset";

defineProps({
  navigationDisabled: {
    type: Boolean,
    default: false,
  },
  themeMode: {
    type: String,
    default: "light",
  },
});

const route = useRoute();
const emit = defineEmits(["route-change", "toggle-theme"]);

const navBrandImage = resolvePublicAssetPath("icons/cmx-logo128.png");
const authorAvatarImage = resolvePublicAssetPath("images/moonshine128x128.jpg");
const showSponsorDialog = ref(false);
const currentRoute = ref("image");

watch(
  () => route.path,
  (newPath) => {
    currentRoute.value = newPath.includes("/video") ? "video" : "image";
  },
  { immediate: true }
);

const handleRouteChange = (value) => {
  emit("route-change", value);
};

const openExternalLink = (url) => {
  if (window.electron) {
    window.electron.ipcRenderer.send("open-external-link", url);
  } else {
    window.open(url, "_blank");
  }
};

const openGithubLink = () => openExternalLink("https://github.com/CuiMuxuan/Moonshine-Image");
const openBilibiliLink = () => openExternalLink("https://space.bilibili.com/589465087");
const openNovelLink = () => openExternalLink("https://www.jjwxc.net/oneauthor.php?authorid=3292754");
</script>

<style scoped>
.toolbar-title {
  max-width: 260px;
  display: flex;
  align-items: center;
  gap: 8px;
}

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
}

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

:deep(.sponsor-dialog .q-dialog),
:deep(.sponsor-dialog .q-dialog__backdrop) {
  z-index: 3000 !important;
}
</style>
