<template>
  <div class="mcp-activity-panel" data-testid="mcp-activity-panel">
    <q-banner v-if="store.error" rounded class="settings-warning-banner q-mb-md">{{ store.error }}</q-banner>
    <div v-if="!store.hasActivity" class="mcp-activity-empty">
      <q-icon name="history" size="24px" />
      <div>
        <div class="text-body2 text-weight-medium">暂无 MCP 活动</div>
        <div class="text-caption text-grey-7">活动日志只显示经过主进程安全投影的摘要字段。</div>
      </div>
    </div>
    <div v-else class="mcp-activity-list">
      <div v-for="event in store.activities" :key="event.cursor" class="mcp-activity-row">
        <div class="mcp-activity-row__meta">
          <q-badge :color="event.outcome === 'accepted' ? 'positive' : event.outcome === 'rejected' ? 'negative' : 'grey-7'" :label="event.outcome || '未知'" />
          <span class="text-caption text-grey-7">#{{ event.cursor }}</span>
        </div>
        <div class="mcp-activity-row__body">
          <strong>{{ event.tool || '未知工具' }}</strong>
          <span>{{ event.code || '无错误码' }}</span>
        </div>
        <div class="text-caption text-grey-7 mcp-activity-row__time">{{ event.timestamp || '无时间戳' }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted } from "vue";
import { useMcpActivityStore } from "src/stores/mcpActivity";

const store = useMcpActivityStore();

onMounted(() => {
  void store.refresh();
});
</script>

<style scoped>
.mcp-activity-empty { display: flex; align-items: flex-start; gap: 10px; padding: 16px; border: 1px dashed var(--settings-border, rgba(17, 24, 39, .12)); border-radius: 10px; color: var(--settings-text-secondary, rgba(17, 24, 39, .62)); }
.mcp-activity-list { display: grid; gap: 8px; }
.mcp-activity-row { display: grid; grid-template-columns: 132px minmax(0, 1fr) minmax(150px, auto); align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--settings-border, rgba(17, 24, 39, .08)); border-radius: 10px; background: var(--settings-field-surface, rgba(255, 255, 255, .55)); }
.mcp-activity-row__meta { display: flex; align-items: center; gap: 8px; }
.mcp-activity-row__body { min-width: 0; display: grid; gap: 3px; }
.mcp-activity-row__body strong, .mcp-activity-row__body span { overflow-wrap: anywhere; }
.mcp-activity-row__time { overflow-wrap: anywhere; text-align: right; }
@media (max-width: 760px) { .mcp-activity-row { grid-template-columns: 1fr; gap: 6px; } .mcp-activity-row__time { text-align: left; } }
</style>
