<template>
  <q-layout view="hHh LpR fFf">
    <q-header elevated class="bg-primary text-white main-header" height-hint="98">
      <main-toolbar
        :navigation-disabled="loadingState.showing"
        :theme-mode="configStore.config.ui?.theme || 'light'"
        @route-change="handleRouteChange"
        @toggle-theme="toggleThemeMode"
      >
        <template #backend>
          <q-btn
            flat
            round
            dense
            icon="terminal"
            class="q-mr-sm"
            @click="showBackendManager = true"
          >
            <q-tooltip>后端管理</q-tooltip>
          </q-btn>
        </template>

        <template #settings>
          <q-btn
            flat
            round
            dense
            icon="settings"
            class="q-mr-sm"
            @click="showSettings = true"
          >
            <q-tooltip>全局设置</q-tooltip>
          </q-btn>
        </template>
      </main-toolbar>
    </q-header>

    <component
      :is="pageLeftDrawerComponent"
      v-if="pageLeftDrawerComponent"
      v-bind="pageLeftDrawerProps"
      v-on="pageLeftDrawerListeners"
      :class="pageLeftDrawerClass"
    />

    <component
      :is="pageRightDrawerComponent"
      v-if="pageRightDrawerComponent"
      v-bind="pageRightDrawerProps"
      v-on="pageRightDrawerListeners"
      :class="pageRightDrawerClass"
    />

    <q-page-container class="main-page-container">
      <div class="page-content-shell">
        <router-view :backend-running="backendRunning" @update:loading="handleLoadingUpdate" />

        <q-inner-loading :showing="loadingState.showing" class="global-loading">
          <div class="global-loading-content">
            <div class="global-loading-logo-shell" aria-hidden="true">
              <img class="global-loading-logo" :src="globalLoadingLogo" alt="" />
            </div>
            <span class="global-loading-message text-h6 text-primary text-center">
              {{ loadingState.message }}
            </span>
            <q-linear-progress
              v-if="typeof loadingState.progress === 'number'"
              :value="loadingState.progress"
              color="primary"
              size="10px"
              class="global-loading-progress"
            />
          </div>
        </q-inner-loading>
      </div>
    </q-page-container>

    <q-footer v-if="pageFooterComponent" class="layout-page-footer" :height-hint="60">
      <component
        :is="pageFooterComponent"
        v-bind="pageFooterProps"
        v-on="pageFooterListeners"
        :class="pageFooterClass"
      />
    </q-footer>
  </q-layout>

  <backend-manager v-model="showBackendManager" />
  <global-settings v-model="showSettings" />
</template>

<script setup>
import { setCssVar, useQuasar } from "quasar";
import { markRaw, onMounted, provide, ref, shallowRef, watch } from "vue";
import { useRouter } from "vue-router";

import { api } from "src/boot/axios";
import BackendManager from "src/components/global/BackendManager.vue";
import GlobalSettings from "src/components/global/GlobalSettings.vue";
import MainToolbar from "src/components/global/MainToolbar.vue";
import { DEFAULT_BRAND_COLORS, normalizeThemeMode } from "src/config/ConfigManager";
import { useAppStateStore } from "src/stores/appState";
import { useConfigStore } from "src/stores/config";
import { resolvePublicAssetPath } from "src/utils/publicAsset";

const $q = useQuasar();
const router = useRouter();
const configStore = useConfigStore();
const appStateStore = useAppStateStore();
const globalLoadingLogo = resolvePublicAssetPath("icons/cmx-logo256.png");

const showBackendManager = ref(false);
const showSettings = ref(false);
const backendRunning = ref(false);

const loadingState = ref({
  showing: false,
  message: "",
  progress: null,
});
const pageFooterOwner = ref(null);
const pageFooterProps = ref({});
const pageFooterListeners = ref({});
const pageFooterClass = ref("");
const pageFooterComponent = shallowRef(null);
const pageLeftDrawerOwner = ref(null);
const pageLeftDrawerProps = ref({});
const pageLeftDrawerListeners = ref({});
const pageLeftDrawerClass = ref("");
const pageLeftDrawerComponent = shallowRef(null);
const pageRightDrawerOwner = ref(null);
const pageRightDrawerProps = ref({});
const pageRightDrawerListeners = ref({});
const pageRightDrawerClass = ref("");
const pageRightDrawerComponent = shallowRef(null);

const resetPageFooter = () => {
  pageFooterOwner.value = null;
  pageFooterProps.value = {};
  pageFooterListeners.value = {};
  pageFooterClass.value = "";
  pageFooterComponent.value = null;
};

const resetPageDrawer = (side) => {
  if (side === "left") {
    pageLeftDrawerOwner.value = null;
    pageLeftDrawerProps.value = {};
    pageLeftDrawerListeners.value = {};
    pageLeftDrawerClass.value = "";
    pageLeftDrawerComponent.value = null;
    return;
  }

  if (side === "right") {
    pageRightDrawerOwner.value = null;
    pageRightDrawerProps.value = {};
    pageRightDrawerListeners.value = {};
    pageRightDrawerClass.value = "";
    pageRightDrawerComponent.value = null;
  }
};

const setPageFooter = ({
  owner = Symbol("page-footer"),
  component = null,
  props = {},
  listeners = {},
  className = "",
} = {}) => {
  if (!component) {
    resetPageFooter();
    return owner;
  }

  pageFooterOwner.value = owner;
  pageFooterProps.value = props;
  pageFooterListeners.value = listeners;
  pageFooterClass.value = className;
  pageFooterComponent.value = markRaw(component);
  return owner;
};

const clearPageFooter = (owner = null) => {
  if (owner !== null && pageFooterOwner.value !== owner) {
    return;
  }

  resetPageFooter();
};

const setPageDrawer = ({
  side,
  owner = Symbol("page-drawer"),
  component = null,
  props = {},
  listeners = {},
  className = "",
} = {}) => {
  if (!side) {
    return owner;
  }

  if (!component) {
    resetPageDrawer(side);
    return owner;
  }

  if (side === "left") {
    pageLeftDrawerOwner.value = owner;
    pageLeftDrawerProps.value = props;
    pageLeftDrawerListeners.value = listeners;
    pageLeftDrawerClass.value = className;
    pageLeftDrawerComponent.value = markRaw(component);
    return owner;
  }

  if (side === "right") {
    pageRightDrawerOwner.value = owner;
    pageRightDrawerProps.value = props;
    pageRightDrawerListeners.value = listeners;
    pageRightDrawerClass.value = className;
    pageRightDrawerComponent.value = markRaw(component);
  }

  return owner;
};

const clearPageDrawer = (side, owner = null) => {
  if (side === "left") {
    if (owner !== null && pageLeftDrawerOwner.value !== owner) {
      return;
    }
    resetPageDrawer("left");
    return;
  }

  if (side === "right") {
    if (owner !== null && pageRightDrawerOwner.value !== owner) {
      return;
    }
    resetPageDrawer("right");
  }
};

const normalizeLoadingMessage = (message = "") =>
  String(message || "").replace(
    /\s*，?\s*可打开后端管理页面查看进度/g,
    "\n可打开后端管理页面查看进度"
  );

const normalizeLoadingPayload = (messageOrOptions, progressArg = null) => {
  if (typeof messageOrOptions === "object" && messageOrOptions !== null) {
    return {
      message: messageOrOptions.message || "加载中...",
      progress:
        typeof messageOrOptions.progress === "number" ? messageOrOptions.progress : null,
    };
  }

  return {
    message: messageOrOptions || "加载中...",
    progress: typeof progressArg === "number" ? progressArg : null,
  };
};

const normalizeBackendHintBreak = (message = "") =>
  normalizeLoadingMessage(message).replace(
    /\s*[\uFF0C,]?\s*\u53ef\u6253\u5f00\u540e\u7aef\u7ba1\u7406\u9875\u9762\u67e5\u770b\u8fdb\u5ea6/g,
    "\n\u53ef\u6253\u5f00\u540e\u7aef\u7ba1\u7406\u9875\u9762\u67e5\u770b\u8fdb\u5ea6"
  );

provide("backendRunning", backendRunning);
provide("layoutFooter", {
  setPageFooter,
  clearPageFooter,
});
provide("layoutDrawers", {
  setPageDrawer,
  clearPageDrawer,
});
provide("loadingControl", {
  show: (messageOrOptions, progress) => {
    const payload = normalizeLoadingPayload(messageOrOptions, progress);
    loadingState.value = {
      showing: true,
      message: normalizeBackendHintBreak(payload.message),
      progress: payload.progress,
    };
  },
  update: (messageOrOptions, progress) => {
    const payload = normalizeLoadingPayload(messageOrOptions, progress);
    loadingState.value = {
      showing: true,
      message: normalizeBackendHintBreak(payload.message),
      progress: payload.progress,
    };
  },
  hide: () => {
    loadingState.value = {
      showing: false,
      message: "",
      progress: null,
    };
  },
});

const handleLoadingUpdate = (state) => {
  if (state.show) {
    const payload = normalizeLoadingPayload(state.message || state, state.progress);
    loadingState.value = {
      showing: true,
      message: normalizeBackendHintBreak(payload.message),
      progress: payload.progress,
    };
    return;
  }

  loadingState.value = {
    showing: false,
    message: "",
    progress: null,
  };
};

const checkBackendStatus = async () => {
  try {
    await api.get("/api/v1/check_cuda");
    backendRunning.value = true;
  } catch (error) {
    backendRunning.value = false;
    $q.notify({
      type: "warning",
      message: `${error} 后端服务未启动，请点击后端管理按钮启动服务。`,
      position: "top",
      timeout: 5000,
      actions: [
        {
          label: "启动后端",
          color: "white",
          handler: () => {
            showBackendManager.value = true;
          },
        },
      ],
    });
  }
};

const handleRouteChange = (value) => {
  router.push(`/${value}`);
};

const applyThemeColors = (brandColors = {}) => {
  const colors = {
    ...DEFAULT_BRAND_COLORS,
    ...(brandColors || {}),
  };

  Object.entries(colors).forEach(([key, value]) => {
    setCssVar(key, value);
  });
};

const applyUiPreferences = () => {
  const uiConfig = configStore.config.ui || {};
  $q.dark.set(normalizeThemeMode(uiConfig.theme) === "dark");
  applyThemeColors(uiConfig.brandColors);
};

const toggleThemeMode = async () => {
  const nextTheme = configStore.config.ui?.theme === "dark" ? "light" : "dark";
  const nextConfig = {
    ...configStore.config,
    ui: {
      ...(configStore.config.ui || {}),
      theme: nextTheme,
    },
  };

  const result = await configStore.persistConfig(nextConfig);
  if (!result.success) {
    $q.notify({
      type: "negative",
      message: `主题切换失败: ${result.error || result.errors?.join("；") || "未知错误"}`,
    });
  }
};

onMounted(async () => {
  await configStore.loadConfig();
  applyUiPreferences();
  api.updateConfig(configStore.config);
  await appStateStore.loadState();
  await checkBackendStatus();
});

watch(
  () => configStore.config,
  () => {
    applyUiPreferences();
    api.updateConfig(configStore.config);
  },
  { deep: true }
);

watch(showBackendManager, (newVal) => {
  if (!newVal) {
    setTimeout(checkBackendStatus, 1000);
  }
});

router.beforeEach(async (to, from) => {
  if (loadingState.value.showing && from.name && from.name !== to.name) {
    $q.notify({
      type: "warning",
      message: "当前任务处理中，暂时不能切换页面。",
      position: "top",
      timeout: 2000,
    });
    return false;
  }

  if (from.name && from.name !== to.name) {
    const result = await appStateStore.switchPage(to.name);

    if (!result.success && result.oversized) {
      const confirmed = await new Promise((resolve) => {
        $q.dialog({
          title: "状态保存失败",
          message: `${result.error}。继续切换将丢失当前页面的未保存内容，是否继续？`,
          cancel: true,
          persistent: true,
        })
          .onOk(() => resolve(true))
          .onCancel(() => resolve(false));
      });

      if (!confirmed) {
        return false;
      }
      await appStateStore.restart();
    }
  }
});
</script>

<style scoped>
:deep(.q-tooltip) {
  z-index: 2100 !important;
}

:deep(.q-menu) {
  z-index: 2100 !important;
}

.main-page-container {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}

.page-content-shell {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.layout-page-footer {
  background: transparent !important;
  color: inherit !important;
  box-shadow: none !important;
}

.main-header,
.layout-page-footer {
  z-index: 2100 !important;
}

.global-loading {
  z-index: 4000 !important;
  pointer-events: none;
}

.global-loading-content {
  width: min(420px, calc(100vw - 48px));
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}

.global-loading-logo-shell {
  width: clamp(84px, 11vw, 132px);
  height: clamp(84px, 11vw, 132px);
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}

.global-loading-logo {
  width: 72%;
  height: 72%;
  object-fit: contain;
  display: block;
  transform-origin: center;
  animation: global-loading-breathe 2.2s ease-in-out infinite;
  will-change: transform, opacity, filter;
}

.global-loading-progress {
  width: 100%;
}

.global-loading-message {
  white-space: pre-line;
  line-height: 1.45;
}

@keyframes global-loading-breathe {
  0%,
  100% {
    transform: scale(0.9);
    opacity: 0.9;
    filter: drop-shadow(0 6px 14px rgba(17, 24, 39, 0.14));
  }

  50% {
    transform: scale(1.08);
    opacity: 1;
    filter: drop-shadow(0 10px 22px rgba(17, 24, 39, 0.22));
  }
}

@media (prefers-reduced-motion: reduce) {
  .global-loading-logo {
    animation: none;
    transform: none;
    opacity: 1;
    filter: none;
  }
}
</style>
