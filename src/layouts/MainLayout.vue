<template>
  <q-layout view="hHh LpR lFf">
    <q-header
      elevated
      class="bg-primary text-white main-header"
      height-hint="98"
    >
      <!-- 主工具栏 -->
      <main-toolbar @route-change="handleRouteChange">
        <!-- 后端管理按钮插槽 -->
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
        <!-- 设置按钮插槽 -->
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

    <!-- 主内容区域 -->
    <q-page-container>
      <router-view
        :backend-running="backendRunning"
        @update:loading="handleLoadingUpdate"
      />
    </q-page-container>
    <!-- 内部加载组件 -->
    <q-inner-loading
      :showing="loadingState.showing"
    >
      <q-spinner-gears size="50px" color="primary" />
      <span class="text-h6 text-primary">{{ loadingState.message }}</span>
    </q-inner-loading>
  </q-layout>
  <!-- 后端管理对话框 -->
  <backend-manager v-model="showBackendManager" />
  <!-- 全局设置对话框 -->
  <global-settings v-model="showSettings" />
</template>

<script setup>
import { useQuasar } from "quasar";
import { ref, watch, onMounted, provide } from "vue";
import { useRouter } from "vue-router";
import MainToolbar from "src/components/MainToolbar.vue";
import BackendManager from "src/components/BackendManager.vue";
import GlobalSettings from "src/components/GlobalSettings.vue";
import { useConfigStore } from "src/stores/config";
import { useAppStateStore } from "src/stores/appState";
import { api } from "src/boot/axios";

const $q = useQuasar();
const router = useRouter();
const configStore = useConfigStore();
const appStateStore = useAppStateStore();
const showBackendManager = ref(false);
const showSettings = ref(false);
const backendRunning = ref(false);

// 加载状态管理
const loadingState = ref({
  showing: false,
  message: "",
});
// 提供后端状态给子组件
provide("backendRunning", backendRunning);
provide("loadingControl", {
  show: (message) => {
    loadingState.value = {
      showing: true,
      message: message || "加载中...",
    };
  },
  hide: () => {
    loadingState.value = {
      showing: false,
      message: "",
    };
  },
});

// 处理子组件的加载状态更新
const handleLoadingUpdate = (state) => {
  if (state.show) {
    loadingState.value = {
      showing: true,
      message: state.message || "加载中...",
    };
  } else {
    loadingState.value = {
      showing: false,
      message: "",
    };
  }
};
// 检查后端状态
const checkBackendStatus = async () => {
  try {
    await api.get("/api/v1/check_cuda");
    backendRunning.value = true;
  } catch (error) {
    backendRunning.value = false;
    // 显示后端未启动提示
    $q.notify({
      type: "warning",
      message: error + "后端服务未启动，请点击后端管理按钮启动服务",
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

// 处理导航切换
const handleRouteChange = (value) => {
  router.push(`/${value}`);
};
// 页面加载时初始化
onMounted(async () => {
  // 加载配置
  await configStore.loadConfig();
  // 更新 axios 配置
  api.updateConfig(configStore.config);
  // 加载状态
  await appStateStore.loadState();
  // 检查后端状态
  await checkBackendStatus();
});

// 监听后端管理器关闭，重新检查后端状态
watch(showBackendManager, (newVal) => {
  if (!newVal) {
    setTimeout(checkBackendStatus, 1000);
  }
});
// 监听路由变化，保存状态
router.beforeEach(async (to, from) => {
  if (from.name && from.name !== to.name) {
    const result = await appStateStore.switchPage(to.name);

    if (!result.success && result.oversized) {
      // 状态过大，询问用户是否继续
      const confirmed = await new Promise((resolve) => {
        $q.dialog({
          title: "状态保存失败",
          message: `${result.error}。继续切换将丢失当前页面的未保存内容。是否继续？`,
          cancel: true,
          persistent: true,
        })
          .onOk(() => resolve(true))
          .onCancel(() => resolve(false));
      });

      if (!confirmed) {
        return false; // 阻止路由切换
      }
      // 清除状态后继续
      await appStateStore.restart();
    }
  }
});
</script>
<style scoped>
/* 工具栏相关元素层级 */
:deep(.q-tooltip) {
  z-index: 2100 !important;
}

:deep(.q-menu) {
  z-index: 2100 !important;
}
</style>
