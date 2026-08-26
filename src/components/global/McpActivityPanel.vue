<template>
  <div class="mcp-activity-panel" data-testid="mcp-activity-panel">
    <q-banner v-if="store.error || store.externalError" rounded class="settings-warning-banner q-mb-md">
      {{ store.error || store.externalError }}
    </q-banner>
    <section v-if="store.pendingApprovals.length" class="mcp-approval-panel q-mb-md" aria-label="待处理审批">
      <div class="mcp-approval-panel__heading">
        <div>
          <div class="text-body2 text-weight-medium">待处理审批</div>
          <div class="text-caption text-grey-7">批准后任务继续；拒绝或超时会安全取消。</div>
        </div>
        <q-badge color="warning" text-color="dark" :label="String(store.pendingApprovals.length)" />
      </div>
      <div class="mcp-approval-list q-mt-sm">
        <div v-for="approval in store.pendingApprovals" :key="approval.approvalId" class="mcp-approval-row">
          <div class="mcp-approval-row__copy">
            <strong>{{ approval.tool || '外部任务' }}</strong>
            <span>{{ approval.clientName || '未知客户端' }}<template v-if="approval.jobGroupId"> · 任务组</template><template v-else-if="approval.jobId"> · 任务</template></span>
          </div>
          <div class="mcp-approval-row__actions">
            <q-btn flat dense no-caps color="negative" label="拒绝" :loading="store.isActionLoading(approval.approvalId)" @click="resolveApproval(approval, 'reject')" />
            <q-btn unelevated dense no-caps color="primary" label="批准" :loading="store.isActionLoading(approval.approvalId)" @click="resolveApproval(approval, 'approve')" />
          </div>
        </div>
      </div>
    </section>
    <div v-if="!store.hasActivity" class="mcp-activity-empty">
      <q-icon name="history" size="24px" />
      <div>
        <div class="text-body2 text-weight-medium">暂无 MCP 活动</div>
        <div class="text-caption text-grey-7">活动日志只显示经过主进程安全投影的摘要字段。</div>
      </div>
    </div>
    <div v-else class="mcp-activity-list">
      <article v-for="event in store.activities" :key="event.cursor" class="mcp-activity-row">
        <div class="mcp-activity-row__meta">
          <q-badge :color="outcomeColor(event)" :label="event.outcome || event.status || '未知'" />
          <span class="text-caption text-grey-7">#{{ event.cursor }}</span>
        </div>
        <div class="mcp-activity-row__body">
          <strong>{{ event.tool || '未知工具' }}</strong>
          <span>{{ eventSummary(event) }}</span>
          <span v-if="event.clientName" class="mcp-activity-row__client">{{ event.clientName }}<template v-if="event.clientVersion"> {{ event.clientVersion }}</template></span>
          <span v-if="event.approval?.status" class="mcp-activity-row__approval">审批：{{ approvalLabel(event.approval.status) }}</span>
          <div v-if="event.fileResults.length" class="mcp-file-result-list" aria-label="逐文件结果">
            <span v-for="(fileResult, index) in event.fileResults" :key="index">文件 {{ index + 1 }}：{{ fileResult.status || fileResult.code || '已完成' }}</span>
          </div>
          <div v-if="event.artifacts.length" class="mcp-artifact-list">
            <q-btn
              v-for="artifact in event.artifacts"
              :key="artifact.artifactId"
              flat dense no-caps color="primary" icon="open_in_new" label="在编辑器中打开"
              :disable="!event.jobId || !store.hasExternalApi"
              :loading="store.isActionLoading(event.jobId + ':' + artifact.artifactId)"
              @click="openArtifact(event, artifact)"
            >
              <q-tooltip>{{ artifact.mimeType || '结果 artifact' }}</q-tooltip>
            </q-btn>
          </div>
        </div>
        <div class="text-caption text-grey-7 mcp-activity-row__time">{{ event.timestamp || '无时间戳' }}</div>
      </article>
    </div>
  </div>
</template>

<script setup>
import { useQuasar } from "quasar";
import { useMcpActivityStore } from "src/stores/mcpActivity";

const store = useMcpActivityStore();
const $q = useQuasar();

const approvalLabel = (value) => ({
  pending: "等待处理", approved: "已批准", rejected: "已拒绝", expired: "已过期", cancelled: "已取消",
}[value] || "未知");

const outcomeColor = (event) => {
  if (["accepted", "completed"].includes(event.outcome) || event.status === "completed") return "positive";
  if (["rejected", "failed", "cancelled"].includes(event.outcome) || event.status === "failed") return "negative";
  if (event.outcome === "pending" || event.status === "pending") return "warning";
  return "grey-7";
};

const eventSummary = (event) => {
  if (event.code) return event.code;
  if (event.jobGroupId) return "任务组";
  if (event.jobId) return "任务";
  return "无错误码";
};

const resolveApproval = async (approval, decision) => {
  const result = await store.resolveApproval(approval.approvalId, decision);
  $q.notify({
    type: result?.success ? "positive" : "negative",
    message: result?.success ? (decision === "approve" ? "任务已批准。" : "任务已拒绝。") : "审批操作失败。",
    position: "top",
  });
};

const openArtifact = async (event, artifact) => {
  // This can only run after an explicit renderer user gesture.
  const result = await store.openArtifactInEditor(event.jobId, artifact.artifactId);
  $q.notify({
    type: result?.success ? "positive" : "negative",
    message: result?.success ? "已在编辑器中打开结果。" : "无法在编辑器中打开该结果。",
    position: "top",
  });
};
</script>

<style scoped>
.mcp-activity-empty { display: flex; align-items: flex-start; gap: 10px; padding: 16px; border: 1px dashed var(--settings-border, rgba(17, 24, 39, .12)); border-radius: 10px; color: var(--settings-text-secondary, rgba(17, 24, 39, .62)); }
.mcp-approval-panel { padding: 12px; border: 1px solid var(--settings-warning-border, rgba(230, 172, 0, .28)); border-radius: 8px; background: var(--settings-warning-surface, rgba(230, 172, 0, .08)); }
.mcp-approval-panel__heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.mcp-approval-list { display: grid; gap: 6px; max-height: 180px; overflow-y: auto; }
.mcp-approval-row { display: flex; min-width: 0; align-items: center; gap: 10px; padding: 8px; border: 1px solid var(--settings-border, rgba(17, 24, 39, .08)); border-radius: 7px; background: var(--settings-field-surface, rgba(255, 255, 255, .55)); }
.mcp-approval-row__copy { display: grid; min-width: 0; flex: 1; gap: 2px; }
.mcp-approval-row__copy strong, .mcp-approval-row__copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mcp-approval-row__copy span { color: var(--settings-text-secondary, rgba(17, 24, 39, .62)); font-size: 11px; }
.mcp-approval-row__actions { display: flex; flex: 0 0 auto; gap: 4px; }
.mcp-activity-list { display: grid; gap: 8px; }
.mcp-activity-row { display: grid; grid-template-columns: 132px minmax(0, 1fr) minmax(150px, auto); align-items: start; gap: 12px; padding: 12px; border: 1px solid var(--settings-border, rgba(17, 24, 39, .08)); border-radius: 8px; background: var(--settings-field-surface, rgba(255, 255, 255, .55)); }
.mcp-activity-row__meta { display: flex; align-items: center; gap: 8px; }
.mcp-activity-row__body { min-width: 0; display: grid; gap: 3px; }
.mcp-activity-row__body strong, .mcp-activity-row__body span { overflow-wrap: anywhere; }
.mcp-activity-row__client, .mcp-activity-row__approval { color: var(--settings-text-secondary, rgba(17, 24, 39, .62)); font-size: 11px; }
.mcp-file-result-list { display: grid; gap: 2px; max-height: 116px; overflow-y: auto; color: var(--settings-text-secondary, rgba(17, 24, 39, .62)); font-size: 11px; }
.mcp-artifact-list { display: flex; flex-wrap: wrap; gap: 2px; }
.mcp-activity-row__time { overflow-wrap: anywhere; text-align: right; }
@media (max-width: 760px) { .mcp-approval-row { align-items: flex-start; flex-direction: column; } .mcp-approval-row__actions { align-self: stretch; justify-content: flex-end; } .mcp-activity-row { grid-template-columns: 1fr; gap: 6px; } .mcp-activity-row__time { text-align: left; } }
</style>
