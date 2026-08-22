<template>
  <div class="mcp-settings-panel" data-testid="mcp-settings-panel">
    <div class="row items-center q-mb-md settings-section-heading">
      <div>
        <div class="text-subtitle1 text-weight-medium">MCP 服务</div>
        <div class="text-caption text-grey-7">策略由主进程保存；启用后由主进程启动 MCP adapter。</div>
      </div>
      <q-space />
      <q-badge :color="store.state.running ? 'positive' : 'grey-7'" :label="store.state.running ? '运行中' : '未运行'" />
    </div>

    <q-banner v-if="store.error || mcpError" rounded class="settings-warning-banner q-mb-md">
      {{ mcpError || store.error }}
    </q-banner>

    <div class="settings-panel-grid">
      <div class="block mcp-status-card">
        <div class="text-subtitle2 text-weight-medium">当前状态</div>
        <div class="mcp-status-grid q-mt-md">
          <div><span>能力</span><strong>{{ store.state.enabled ? "已启用" : "已关闭" }}</strong></div>
          <div><span>活动游标</span><strong>{{ store.state.activity_cursor }}</strong></div>
          <div class="mcp-status-grid__wide"><span>允许工具</span><strong>{{ store.state.allowed_tools.join('、') || '无' }}</strong></div>
        </div>
        <div class="row q-gutter-sm q-mt-md">
          <q-btn
            outline
            dense
            no-caps
            color="primary"
            icon="refresh"
            label="刷新状态"
            :loading="store.loading || mcpLoading"
            @click="refreshAll"
          />
          <q-btn
            flat
            dense
            no-caps
            color="primary"
            icon="open_in_new"
            label="查看活动日志"
            @click="openActivity"
          />
          <q-btn
            v-if="store.state.enabled && !store.state.running"
            flat
            dense
            no-caps
            color="primary"
            icon="play_arrow"
            label="启动 MCP"
            :loading="store.starting"
            @click="store.start"
          />
          <q-btn
            v-if="store.state.running"
            flat
            dense
            no-caps
            color="negative"
            icon="stop_circle"
            label="停止 MCP"
            :loading="store.stopping"
            @click="store.stop"
          />
        </div>
      </div>

      <div class="block mcp-policy-card">
        <div class="row items-center">
          <div>
            <div class="text-subtitle2 text-weight-medium">连接策略</div>
            <div class="text-caption text-grey-7">只保存启用资格、配置档、工具和目录白名单，不保存凭据。</div>
          </div>
          <q-space />
          <q-toggle
            v-model="mcpConfig.enabled"
            color="primary"
            label="启用 MCP 服务"
            :disable="mcpLoading || mcpSaving"
          />
        </div>

        <div class="mcp-policy-grid q-mt-md">
          <q-input
            v-model="mcpConfig.profileId"
            outlined
            dense
            label="配置档 ID"
            maxlength="64"
            :disable="mcpLoading || mcpSaving"
          />
          <q-toggle
            v-model="mcpConfig.confirmationRequired"
            color="primary"
            label="工具调用需要确认"
            :disable="mcpLoading || mcpSaving"
          />
        </div>

        <q-select
          v-model="mcpConfig.allowedTools"
          class="q-mt-md"
          outlined
          dense
          multiple
          use-chips
          emit-value
          map-options
          label="允许工具"
          :options="toolOptions"
          :disable="mcpLoading || mcpSaving"
        />

        <div class="row items-center q-mt-md">
          <div>
            <div class="text-body2 text-weight-medium">允许目录</div>
            <div class="text-caption text-grey-7">仅接受主进程确认存在且不是符号链接的目录。</div>
          </div>
          <q-space />
          <q-btn
            outline
            dense
            no-caps
            color="primary"
            icon="folder_open"
            label="选择目录"
            :loading="mcpRootLoading"
            :disable="mcpLoading || mcpSaving"
            @click="selectRoot"
          >
            <q-tooltip>通过主进程选择允许目录</q-tooltip>
          </q-btn>
        </div>

        <q-list v-if="mcpConfig.allowedRoots.length" bordered separator class="mcp-root-list q-mt-sm">
          <q-item v-for="root in mcpConfig.allowedRoots" :key="root" dense>
            <q-item-section>
              <q-item-label class="mcp-root-path">{{ root }}</q-item-label>
            </q-item-section>
            <q-item-section side>
              <q-btn
                round
                flat
                dense
                color="negative"
                icon="delete_outline"
                :aria-label="`移除允许目录 ${root}`"
                :disable="mcpSaving"
                @click="removeRoot(root)"
              >
                <q-tooltip>移除允许目录</q-tooltip>
              </q-btn>
            </q-item-section>
          </q-item>
        </q-list>
        <div v-else class="text-caption text-grey-7 q-mt-sm">尚未选择允许目录。</div>

        <div class="row justify-end q-mt-md">
          <q-btn
            unelevated
            dense
            no-caps
            color="primary"
            icon="save"
            label="保存 MCP 策略"
            :loading="mcpSaving"
            :disable="mcpLoading"
            @click="saveMcpConfig"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import {
  DEFAULT_MCP_CONFIG,
  MCP_ALLOWED_TOOL_OPTIONS,
} from "src/shared/appConfigSchema";
import { useMcpActivityStore } from "src/stores/mcpActivity";

const router = useRouter();
const store = useMcpActivityStore();
const toolOptions = MCP_ALLOWED_TOOL_OPTIONS.map((value) => ({ label: value, value }));

const createDefaultPolicy = () => ({
  enabled: DEFAULT_MCP_CONFIG.enabled,
  profileId: DEFAULT_MCP_CONFIG.profileId,
  allowedTools: [],
  allowedRoots: [],
  confirmationRequired: DEFAULT_MCP_CONFIG.confirmationRequired,
});

const mcpLoading = ref(false);
const mcpSaving = ref(false);
const mcpRootLoading = ref(false);
const mcpError = ref("");
const mcpConfig = ref(createDefaultPolicy());

const electronApi = () => (typeof window !== "undefined" ? window.electron : null);

const errorMessage = (code) => ({
  MCP_ROOT_INVALID: "目录未通过主进程安全校验。",
  MCP_TOKEN_MATERIAL_REJECTED: "MCP 策略不能包含凭据字段。",
  MCP_CONFIG_INVALID: "MCP 策略格式无效。",
}[code] || "MCP 设置操作未完成。");

const applyPolicy = (value) => {
  const source = value && typeof value === "object" ? value : {};
  mcpConfig.value = {
    enabled: source.enabled === true,
    profileId: typeof source.profileId === "string" ? source.profileId : DEFAULT_MCP_CONFIG.profileId,
    allowedTools: Array.isArray(source.allowedTools)
      ? source.allowedTools.filter((tool) => MCP_ALLOWED_TOOL_OPTIONS.includes(tool))
      : [],
    allowedRoots: Array.isArray(source.allowedRoots)
      ? source.allowedRoots.filter((root) => typeof root === "string")
      : [],
    confirmationRequired: source.confirmationRequired !== false,
  };
};

const loadMcpConfig = async () => {
  const api = electronApi();
  if (!api?.getMcpConfig) return;
  mcpLoading.value = true;
  mcpError.value = "";
  try {
    const result = await api.getMcpConfig();
    if (!result?.success) {
      mcpError.value = errorMessage(result?.code);
      return;
    }
    applyPolicy(result.data);
  } catch {
    mcpError.value = "MCP 设置操作未完成。";
  } finally {
    mcpLoading.value = false;
  }
};

const saveMcpConfig = async () => {
  const api = electronApi();
  if (!api?.saveMcpConfig) return;
  mcpSaving.value = true;
  mcpError.value = "";
  try {
    const result = await api.saveMcpConfig({
      enabled: mcpConfig.value.enabled === true,
      profileId: mcpConfig.value.profileId,
      allowedTools: [...mcpConfig.value.allowedTools],
      allowedRoots: [...mcpConfig.value.allowedRoots],
      confirmationRequired: mcpConfig.value.confirmationRequired !== false,
    });
    if (!result?.success) {
      mcpError.value = errorMessage(result?.code);
      return;
    }
    applyPolicy(result.data);
  } catch {
    mcpError.value = "MCP 设置操作未完成。";
  } finally {
    mcpSaving.value = false;
  }
};

const selectRoot = async () => {
  const api = electronApi();
  if (!api?.selectMcpRoot) return;
  mcpRootLoading.value = true;
  mcpError.value = "";
  try {
    const result = await api.selectMcpRoot();
    if (!result?.success) {
      mcpError.value = errorMessage(result?.code);
      return;
    }
    if (result.cancelled || typeof result.data !== "string") return;
    if (!mcpConfig.value.allowedRoots.includes(result.data)) {
      mcpConfig.value.allowedRoots.push(result.data);
    }
  } catch {
    mcpError.value = "MCP 设置操作未完成。";
  } finally {
    mcpRootLoading.value = false;
  }
};

const removeRoot = (root) => {
  mcpConfig.value.allowedRoots = mcpConfig.value.allowedRoots.filter((item) => item !== root);
};

const refreshAll = async () => {
  await Promise.all([loadMcpConfig(), store.refresh()]);
};

const openActivity = () => router.push("/activity/mcp");

onMounted(() => {
  void refreshAll();
});
</script>

<style scoped>
.mcp-status-card,
.mcp-policy-card { padding: 16px; }
.mcp-status-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.mcp-status-grid > div { min-width: 0; padding: 10px; border: 1px solid var(--settings-border, rgba(17, 24, 39, .08)); border-radius: 10px; }
.mcp-status-grid span { display: block; color: var(--settings-text-secondary, rgba(17, 24, 39, .62)); font-size: 11px; }
.mcp-status-grid strong { display: block; margin-top: 3px; overflow-wrap: anywhere; font-size: 12px; line-height: 1.5; }
.mcp-status-grid__wide { grid-column: 1 / -1; }
.mcp-policy-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, auto); gap: 12px; align-items: center; }
.mcp-root-list { border-radius: 10px; }
.mcp-root-path { overflow-wrap: anywhere; word-break: break-word; }
@media (max-width: 760px) {
  .mcp-status-grid,
  .mcp-policy-grid { grid-template-columns: minmax(0, 1fr); }
  .mcp-status-grid__wide { grid-column: auto; }
}
</style>
