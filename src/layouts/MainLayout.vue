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

    <q-page-container class="main-page-container">
      <div class="page-content-shell">
        <router-view :backend-running="backendRunning" @update:loading="handleLoadingUpdate" />

        <q-inner-loading :showing="loadingState.showing" class="global-loading">
          <div class="global-loading-content">
            <q-spinner-gears size="50px" color="primary" />
            <span class="text-h6 text-primary text-center">{{ loadingState.message }}</span>
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
  </q-layout>

  <backend-manager v-model="showBackendManager" />
  <global-settings v-model="showSettings" />
</template>

<script setup>
import { setCssVar, useQuasar } from "quasar";
import { onMounted, provide, ref, watch } from "vue";
import { useRouter } from "vue-router";

import { api } from "src/boot/axios";
import BackendManager from "src/components/BackendManager.vue";
import GlobalSettings from "src/components/GlobalSettings.vue";
import MainToolbar from "src/components/MainToolbar.vue";
import { DEFAULT_BRAND_COLORS, normalizeThemeMode } from "src/config/ConfigManager";
import { useAppStateStore } from "src/stores/appState";
import { useConfigStore } from "src/stores/config";

const $q = useQuasar();
const router = useRouter();
const configStore = useConfigStore();
const appStateStore = useAppStateStore();

const showBackendManager = ref(false);
const showSettings = ref(false);
const backendRunning = ref(false);

const loadingState = ref({
  showing: false,
  message: "",
  progress: null,
});

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

provide("backendRunning", backendRunning);
provide("loadingControl", {
  show: (messageOrOptions, progress) => {
    const payload = normalizeLoadingPayload(messageOrOptions, progress);
    loadingState.value = {
      showing: true,
      message: payload.message,
      progress: payload.progress,
    };
  },
  update: (messageOrOptions, progress) => {
    const payload = normalizeLoadingPayload(messageOrOptions, progress);
    loadingState.value = {
      showing: true,
      message: payload.message,
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
      message: payload.message,
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
  overflow: hidden;
}

.page-content-shell {
  position: relative;
  min-height: calc(100vh - 50px);
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

.global-loading-progress {
  width: 100%;
}
</style>
