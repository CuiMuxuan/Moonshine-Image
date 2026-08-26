<template>
  <div class="mcp-activity-page q-pa-md">
    <div class="mcp-activity-page__header row items-center q-mb-md">
      <div>
        <div class="text-h6">MCP 活动日志</div>
        <div class="text-caption text-grey-7">通过全局设置中的 MCP Tab 或托盘菜单进入。</div>
      </div>
      <q-space />
      <q-btn flat round dense icon="refresh" aria-label="刷新 MCP 活动日志" :loading="store.loading" @click="store.refresh">
        <q-tooltip>刷新活动日志</q-tooltip>
      </q-btn>
      <q-btn flat round dense icon="arrow_back" aria-label="返回图片处理" @click="$router.push('/image')">
        <q-tooltip>返回图片处理</q-tooltip>
      </q-btn>
    </div>
    <q-card flat bordered class="mcp-activity-page__card">
      <q-card-section>
        <McpActivityPanel />
      </q-card-section>
    </q-card>
  </div>
</template>

<script setup>
import { onMounted } from "vue";
import McpActivityPanel from "src/components/global/McpActivityPanel.vue";
import { useMcpActivityStore } from "src/stores/mcpActivity";

const store = useMcpActivityStore();

onMounted(() => {
  void store.refresh();
});
</script>

<style scoped>
.mcp-activity-page { width: min(1120px, 100%); margin: 0 auto; }
.mcp-activity-page__header { min-height: 48px; }
.mcp-activity-page__card { border-radius: 10px; }
</style>
