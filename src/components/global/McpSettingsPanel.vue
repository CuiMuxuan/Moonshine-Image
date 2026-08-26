<template>
  <div class="mcp-settings-panel" data-testid="mcp-settings-panel">
    <div class="row items-center q-mb-md settings-section-heading mcp-panel-heading">
      <div class="mcp-panel-heading__icon" aria-hidden="true">
        <q-icon name="hub" size="20px" />
      </div>
      <div class="mcp-panel-heading__copy">
        <div class="text-subtitle1 text-weight-medium">MCP 服务</div>
        <div class="text-caption text-grey-7">主进程负责启动、认证和停止 adapter；此页面只保存安全策略。</div>
      </div>
      <q-space />
    </div>

    <q-banner v-if="!electronMcpAvailable" rounded class="mcp-capability-banner q-mb-md mcp-error-banner">
      <template #avatar>
        <q-icon name="desktop_windows" />
      </template>
      {{ electronCapabilityMessage }} 当前页面可查看配置结构，但不能读取状态、选择目录或保存策略。
    </q-banner>

    <q-banner v-else-if="panelErrorMessage" rounded class="mcp-error-banner q-mb-md">
      <template #avatar>
        <q-icon name="warning" />
      </template>
      {{ panelErrorMessage }}
    </q-banner>

    <div class="mcp-status-strip" aria-live="polite">
      <span
        class="mcp-status-indicator"
        :class="{
          'is-running': store.state.running,
          'is-failed': store.state.status === 'failed',
        }"
        aria-hidden="true"
      ></span>
      <div class="mcp-status-copy">
        <strong>{{ serviceStatusLabel }}</strong>
        <span>{{ serviceStatusSummary }}</span>
      </div>
      <q-space />
      <div class="mcp-status-actions">
        <q-btn
          flat
          round
          dense
          color="primary"
          icon="refresh"
          aria-label="刷新 MCP 状态"
          :loading="store.loading || mcpLoading"
          :disable="!electronMcpAvailable"
          @click="refreshAll({ notifyResult: true })"
        >
          <q-tooltip>{{ electronMcpAvailable ? "刷新状态" : "仅 Electron 可用" }}</q-tooltip>
        </q-btn>
        <q-btn
          flat
          round
          dense
          color="primary"
          icon="history"
          aria-label="查看 MCP 活动日志"
          :disable="!electronMcpAvailable"
          @click="openActivity"
        >
          <q-tooltip>{{ electronMcpAvailable ? "查看活动日志" : "仅 Electron 可用" }}</q-tooltip>
        </q-btn>
        <q-btn
          v-if="!store.state.running"
          unelevated
          no-caps
          dense
          color="primary"
          icon="play_arrow"
          label="启动"
          class="mcp-lifecycle-button"
          aria-label="启动 MCP 服务"
          :loading="lifecycleIntent === 'start'"
          :disable="lifecycleControlsDisabled"
          @click="startMcpService"
        />
        <q-btn
          v-else
          outline
          no-caps
          dense
          color="negative"
          icon="stop_circle"
          label="停止"
          class="mcp-lifecycle-button"
          aria-label="停止 MCP 服务"
          :loading="lifecycleIntent === 'stop'"
          :disable="lifecycleControlsDisabled"
          @click="stopMcpService"
        />
      </div>
    </div>

    <q-tabs
      v-model="activeSection"
      dense
      no-caps
      align="left"
      active-color="primary"
      indicator-color="primary"
      narrow-indicator
      class="mcp-section-tabs q-mt-md"
      aria-label="MCP 页面"
    >
      <q-tab name="settings" icon="tune" label="服务设置" />
      <q-tab name="activity" icon="history" label="活动日志" />
    </q-tabs>
    <q-separator />

    <q-tab-panels v-model="activeSection" animated class="mcp-section-panels">
      <q-tab-panel name="settings" class="q-px-none q-pb-none">
        <div class="mcp-module-grid">
          <section class="block mcp-module-card mcp-client-card">
            <div class="mcp-card-heading">
              <div class="mcp-card-heading__icon" aria-hidden="true"><q-icon name="badge" /></div>
              <div>
                <div class="text-subtitle2 text-weight-medium">客户端配置</div>
                <div class="text-caption text-grey-7">任何兼容 MCP stdio 的客户端都可使用同一份配置。</div>
              </div>
            </div>
            <template v-if="externalApiAvailable">
              <q-input
                :model-value="clientConfiguration.jsonTemplate || ''"
                class="q-mt-md mcp-client-preview"
                outlined
                dense
                readonly
                type="textarea"
                autogrow
                label="MCP stdio 配置"
                :hint="clientConfigurationHint"
                persistent-hint
              >
                <template #append>
                  <q-btn flat round dense icon="content_copy" aria-label="复制 MCP stdio 配置" :disable="!clientConfiguration.jsonTemplate" @click="copyClientConfiguration">
                    <q-tooltip>复制配置</q-tooltip>
                  </q-btn>
                </template>
              </q-input>
              <div class="mcp-client-actions q-mt-sm">
                <q-btn flat dense no-caps color="primary" icon="terminal" label="复制启动命令" :disable="!clientCommand" @click="copyClientCommand" />
                <q-btn flat dense no-caps color="primary" icon="network_check" label="检查连通性" :loading="externalProbeLoading" @click="probeExternalProxy" />
              </div>
              <div v-if="externalProbeMessage" class="mcp-inline-feedback q-mt-sm" :class="{ 'is-error': externalProbeFailed }">
                <q-icon :name="externalProbeFailed ? 'error_outline' : 'check_circle_outline'" size="16px" />
                <span>{{ externalProbeMessage }}</span>
              </div>
              <div class="mcp-session-list q-mt-sm" aria-live="polite">
                <div class="mcp-session-list__heading">
                  <span>已连接会话</span>
                  <q-badge outline color="grey-7" :label="String(clientSessions.length)" />
                </div>
                <div v-if="clientSessions.length" class="mcp-session-list__viewport">
                  <div v-for="session in clientSessions" :key="session.sessionId" class="mcp-session-row">
                    <div class="mcp-session-row__copy">
                      <strong>{{ session.clientName }}</strong>
                      <span>{{ session.clientVersion || '版本未知' }} · {{ session.status }}</span>
                    </div>
                    <q-btn flat round dense color="negative" icon="link_off" :aria-label="`断开 ${session.clientName}`" @click="disconnectClientSession(session)">
                      <q-tooltip>断开会话</q-tooltip>
                    </q-btn>
                  </div>
                </div>
                <span v-else class="text-caption text-grey-7">暂无外部客户端连接。</span>
              </div>
            </template>
            <div v-else class="mcp-empty-state q-mt-md">
              <q-icon name="terminal" size="18px" />
              <span>当前应用尚未提供外部 stdio 代理。升级后可在这里复制通用客户端配置并检查连接状态。</span>
            </div>
          </section>

          <section class="block mcp-module-card mcp-confirmation-card">
            <div class="mcp-card-heading">
              <div class="mcp-card-heading__icon" aria-hidden="true"><q-icon name="verified_user" /></div>
              <div>
                <div class="text-subtitle2 text-weight-medium">确认策略</div>
                <div class="text-caption text-grey-7">决定外部任务的可执行范围与审批方式。</div>
              </div>
            </div>
            <div class="mcp-confirmation-options q-mt-md" role="radiogroup" aria-label="确认策略">
              <q-radio
                v-for="option in confirmationModeOptions"
                :key="option.value"
                v-model="mcpConfig.confirmationMode"
                :val="option.value"
                color="primary"
                :disable="controlsDisabled"
              >
                <div class="mcp-confirmation-option__copy">
                  <div class="text-body2 text-weight-medium">{{ option.label }}</div>
                  <div class="text-caption text-grey-7">{{ option.description }}</div>
                </div>
              </q-radio>
            </div>
          </section>

          <section class="block mcp-module-card">
        <div class="mcp-card-heading">
          <div class="mcp-card-heading__icon" aria-hidden="true"><q-icon name="folder_open" /></div>
          <div>
            <div class="text-subtitle2 text-weight-medium">目录权限</div>
            <div class="text-caption text-grey-7">用于自动审批任务的可信目录范围。</div>
          </div>
          <q-space />
          <q-badge :label="`${mcpConfig.allowedRoots.length}/16`" color="grey-7" outline />
          <q-btn round flat dense color="primary" icon="create_new_folder" aria-label="选择信任的目录" :loading="mcpRootLoading" :disable="controlsDisabled" @click="selectRoot">
            <q-tooltip>选择信任的目录</q-tooltip>
          </q-btn>
        </div>
        <q-list v-if="mcpConfig.allowedRoots.length" bordered separator class="mcp-root-list q-mt-md">
          <q-item v-for="root in mcpConfig.allowedRoots" :key="root" dense>
            <q-item-section>
              <q-item-label class="mcp-root-path">{{ root }}</q-item-label>
            </q-item-section>
            <q-item-section side>
              <q-btn round flat dense color="negative" icon="delete_outline" :aria-label="`移除允许目录 ${root}`" :disable="controlsDisabled" @click="removeRoot(root)">
                <q-tooltip>移除允许目录</q-tooltip>
              </q-btn>
            </q-item-section>
          </q-item>
        </q-list>
        <div v-else class="mcp-empty-state q-mt-md">
          <q-icon name="folder_off" size="18px" />
          <span>尚未选择允许目录；启用 MCP 前至少添加一个目录。</span>
        </div>
          </section>

          <section class="block mcp-module-card">
        <div class="mcp-card-heading">
          <div class="mcp-card-heading__icon" aria-hidden="true"><q-icon name="extension" /></div>
          <div>
            <div class="text-subtitle2 text-weight-medium">工具权限</div>
            <div class="text-caption text-grey-7">只允许所选工具被外部 MCP 客户端调用。</div>
          </div>
          <q-space />
          <q-badge :label="`${mcpConfig.allowedTools.length}/${toolOptions.length}`" color="grey-7" outline />
        </div>
        <q-select
          :model-value="mcpConfig.allowedTools"
          class="q-mt-md mcp-tool-select"
          outlined
          dense
          multiple
          use-chips
          emit-value
          map-options
          label="选择工具白名单"
          :options="toolOptions"
          :disable="controlsDisabled"
          @update:model-value="updateAllowedTools"
        >
          <template #option="scope">
            <q-item v-bind="scope.itemProps" class="mcp-tool-option">
              <q-item-section avatar>
                <q-icon :name="scope.opt.icon" color="primary" />
              </q-item-section>
              <q-item-section>
                <q-item-label>{{ scope.opt.label }}</q-item-label>
                <q-item-label caption>{{ scope.opt.description }}</q-item-label>
              </q-item-section>
              <q-item-section side>
                <q-checkbox
                  :model-value="scope.selected"
                  color="primary"
                  tabindex="-1"
                  @click.stop="scope.toggleOption(scope.opt)"
                />
              </q-item-section>
            </q-item>
          </template>
          <template #selected-item="scope">
            <q-chip
              dense
              square
              color="primary"
              text-color="white"
              removable
              class="mcp-tool-chip"
              @remove="scope.removeAtIndex(scope.index)"
            >
              <q-icon :name="scope.opt.icon" size="14px" class="q-mr-xs" />
              {{ scope.opt.label }}
            </q-chip>
          </template>
        </q-select>
          </section>
        </div>

        <div class="mcp-autosave-status q-mt-md" aria-live="polite">
          <q-spinner v-if="mcpSaving" color="primary" size="16px" />
          <q-icon v-else name="cloud_done" color="positive" size="17px" />
          <span>{{ mcpSaving ? "正在保存 MCP 策略…" : "MCP 策略会自动保存，不受全局保存或取消影响。" }}</span>
        </div>
      </q-tab-panel>

      <q-tab-panel name="activity" class="q-px-none q-pb-none">
        <div class="mcp-activity-toolbar">
          <div>
            <div class="text-subtitle2 text-weight-medium">活动日志</div>
            <div class="text-caption text-grey-7">仅显示经过主进程安全投影的活动摘要。</div>
          </div>
          <q-space />
          <q-btn
            flat
            no-caps
            dense
            color="primary"
            icon="refresh"
            label="刷新"
            :loading="store.loading"
            :disable="!electronMcpAvailable"
            @click="refreshActivity({ notifyResult: true })"
          />
        </div>
        <div class="mcp-activity-viewport q-mt-md">
          <McpActivityPanel />
        </div>
      </q-tab-panel>
    </q-tab-panels>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { copyToClipboard, useQuasar } from "quasar";
import McpActivityPanel from "src/components/global/McpActivityPanel.vue";
import {
  DEFAULT_MCP_CONFIG,
  MCP_ALLOWED_TOOL_OPTIONS,
} from "src/shared/appConfigSchema";
import { useMcpActivityStore } from "src/stores/mcpActivity";
import { getElectronMcpCapability } from "src/utils/electronMcpApi";
import {
  areMcpPolicySnapshotsEqual,
  createMcpPolicySnapshot,
  getMcpPolicyEligibility,
} from "src/utils/mcpPolicyEligibility";

const props = defineProps({
  initialTab: { type: String, default: "settings" },
  navigationKey: { type: Number, default: 0 },
});

const $q = useQuasar();
const store = useMcpActivityStore();
const TOOL_METADATA = Object.freeze({
  "moonshine.status": { label: "服务状态", description: "读取应用与 MCP 的可用状态。", icon: "monitor_heart" },
  "moonshine.capabilities": { label: "查看能力", description: "查看当前 MCP 服务支持的工具。", icon: "info" },
  "moonshine.models.list": { label: "查看模型", description: "读取已安装并可用的模型摘要。", icon: "view_in_ar" },
  "moonshine.ocr.detect": { label: "OCR 文本检测", description: "检测图片中的文本区域和候选蒙版。", icon: "text_fields" },
  "moonshine.masks.generate": { label: "智能选区蒙版", description: "生成 OCR、SAM 或增强后的候选蒙版。", icon: "gesture" },
  "moonshine.image.process": { label: "单张图片处理", description: "提交单张去文字、水印或图标处理任务。", icon: "image" },
  "moonshine.image.process_batch": { label: "图片批处理", description: "提交受允许目录约束的图片处理任务。", icon: "image" },
  "moonshine.jobs.get": { label: "查询任务", description: "读取任务的当前状态。", icon: "query_stats" },
  "moonshine.jobs.result": { label: "读取结果", description: "读取任务生成的安全结果摘要。", icon: "assignment_turned_in" },
  "moonshine.jobs.cancel": { label: "取消任务", description: "取消仍在执行中的任务。", icon: "cancel" },
  "moonshine.job_groups.get": { label: "查询任务组", description: "读取拆分批量任务的汇总状态。", icon: "account_tree" },
  "moonshine.job_groups.cancel": { label: "取消任务组", description: "取消尚未完成的拆分批量任务。", icon: "cancel_presentation" },
});
const toolOptions = MCP_ALLOWED_TOOL_OPTIONS.map((value) => ({
  value,
  ...(TOOL_METADATA[value] || { label: value, description: "MCP 工具。", icon: "extension" }),
}));
const SERVICE_STATUS_LABELS = Object.freeze({
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  stopped: "未运行",
  failed: "启动失败",
});
const confirmationModeOptions = Object.freeze([
  {
    label: "只读",
    value: "read_only",
    description: "可查询能力、模型、状态和检测结果；不创建输出文件。",
  },
  {
    label: "自动审批",
    value: "auto_approve",
    description: "允许处理并写入新文件；仍受工具白名单、参数校验和可信目录限制。",
  },
  {
    label: "完全访问权限",
    value: "full_access",
    description: "允许处理并跳过目录 containment；仍受工具白名单与参数校验限制。",
  },
]);

const createDefaultPolicy = () => ({
  enabled: DEFAULT_MCP_CONFIG.enabled,
  profileId: DEFAULT_MCP_CONFIG.profileId,
  allowedTools: [],
  allowedRoots: [],
  confirmationMode: DEFAULT_MCP_CONFIG.confirmationMode || "read_only",
});

const mcpLoading = ref(false);
const mcpSaving = ref(false);
const mcpRootLoading = ref(false);
const mcpError = ref("");
const mcpConfig = ref(createDefaultPolicy());
const externalProbeLoading = ref(false);
const externalProbeMessage = ref("");
const externalProbeFailed = ref(false);
const activeSection = ref(props.initialTab === "activity" ? "activity" : "settings");
const lifecycleIntent = ref("");
let applyingRemotePolicy = false;
let suppressAutosave = 0;
let autosaveTimer = null;
let saveChain = Promise.resolve();
let pendingSaveCount = 0;
let mcpSaveEpoch = 0;
let skipNextActivityRefresh = false;

const electronMcpCapability = computed(() => getElectronMcpCapability());
const electronApi = () => electronMcpCapability.value.api;
const electronMcpAvailable = computed(() => electronMcpCapability.value.available);
const externalApiAvailable = computed(() => electronMcpCapability.value.externalAvailable === true && store.hasExternalApi);
const clientConfiguration = computed(() => store.clientConfiguration);
const clientSessions = computed(() => store.clientSessions);
const clientCommand = computed(() => {
  const command = clientConfiguration.value.command;
  return command ? [command, ...clientConfiguration.value.args].join(" ") : "";
});
const clientConfigurationHint = computed(() => {
  if (!clientConfiguration.value.available) return "外部 stdio 代理暂不可用。";
  return clientConfiguration.value.protocolVersion
    ? "MCP 协议 " + clientConfiguration.value.protocolVersion + "；复制后由客户端自行保存。"
    : "复制后由客户端自行保存；应用不会修改第三方客户端配置。";
});
const electronCapabilityMessage = computed(() =>
  electronMcpCapability.value.environment === "browser"
    ? "MCP 服务设置仅在 Electron 应用中可用。"
    : "Electron 已加载，但 MCP 主进程桥接不完整。",
);
const controlsDisabled = computed(() =>
  !electronMcpAvailable.value || mcpLoading.value || mcpSaving.value || mcpRootLoading.value || Boolean(lifecycleIntent.value)
);
const lifecycleControlsDisabled = computed(() =>
  !electronMcpAvailable.value || mcpLoading.value || mcpSaving.value || Boolean(lifecycleIntent.value)
);

const errorMessage = (code) => ({
  MCP_ROOT_INVALID: "目录未通过主进程安全校验。",
  MCP_ALLOWED_ROOT_REQUIRED: "启用 MCP 前至少选择一个允许目录。",
  MCP_ALLOWED_ROOT_INVALID: "允许目录未通过主进程安全校验，请重新选择。",
  MCP_ALLOWED_TOOL_REQUIRED: "启用 MCP 前至少选择一个允许工具。",
  MCP_ALLOWED_TOOL_AND_ROOT_REQUIRED: "启用 MCP 前至少选择一个允许工具和一个允许目录。",
  MCP_TOKEN_MATERIAL_REJECTED: "MCP 策略不能包含凭据字段。",
  MCP_CONFIG_INVALID: "MCP 策略格式无效。",
}[code] || "MCP 设置操作未完成。");

const serviceStatusLabel = computed(() =>
  store.state.running ? "运行中" : SERVICE_STATUS_LABELS[store.state.status] || "未运行"
);
const serviceStatusSummary = computed(() => {
  if (!electronMcpAvailable.value) {
    return electronMcpCapability.value.environment === "browser"
      ? "仅 Electron 应用可用"
      : "MCP 主进程桥接不可用";
  }
  if (store.state.running) {
    return `${store.state.allowed_tools.length} 个工具 · ${store.activities.length} 条活动`;
  }
  if (store.state.status === "failed") return "请检查允许目录、工具权限和错误提示";
  return store.state.enabled ? "策略已启用，adapter 当前未运行" : "策略未启用";
});
const runtimeErrorMessage = computed(() =>
  store.state.error_code ? errorMessage(store.state.error_code) : ""
);
const panelErrorMessage = computed(() =>
  mcpError.value || runtimeErrorMessage.value || store.error
);
const notifyAction = (type, message) => {
  $q.notify({ type, message, position: "top", timeout: type === "negative" ? 4200 : 2200 });
};
const ensureElectronCapability = () => {
  if (electronMcpAvailable.value) return true;
  mcpError.value = electronMcpCapability.value.environment === "browser"
    ? electronCapabilityMessage.value
    : `${electronCapabilityMessage.value}请重新启动应用。`;
  notifyAction("warning", mcpError.value);
  return false;
};

const applyPolicy = (value) => {
  suppressAutosave += 1;
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
    confirmationMode: ["read_only", "auto_approve", "full_access"].includes(source.confirmationMode)
      ? source.confirmationMode
      : source.confirmationRequired === false
        ? "auto_approve"
        : "read_only",
  };
};

const policyPayload = (source = mcpConfig.value) => createMcpPolicySnapshot(source);

const enqueueMcpSave = (payload = policyPayload()) => {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  const snapshot = policyPayload(payload);
  pendingSaveCount += 1;
  mcpSaving.value = true;
  const saveEpoch = mcpSaveEpoch;
  saveChain = saveChain
    .catch(() => null)
    .then(() => {
      // A failed enabled save invalidates queued enabled snapshots. Persist the
      // current disabled policy instead of allowing a stale request to reopen
      // MCP after the UI has already rolled the switch back.
      const effectiveSnapshot =
        saveEpoch !== mcpSaveEpoch && snapshot.enabled === true
          ? policyPayload()
          : snapshot;
      return saveMcpConfig(effectiveSnapshot);
    })
    .finally(() => {
      pendingSaveCount = Math.max(0, pendingSaveCount - 1);
      mcpSaving.value = pendingSaveCount > 0;
    });
  return saveChain;
};

const rollbackIncompletePolicy = ({ notify = true, persist = true } = {}) => {
  const eligibility = getMcpPolicyEligibility(mcpConfig.value);
  if (eligibility.eligible) return false;

  if (mcpConfig.value.enabled) {
    suppressAutosave += 1;
    mcpConfig.value.enabled = false;
  }
  mcpError.value = eligibility.message;
  if (notify) notifyAction("warning", eligibility.message);
  if (persist) void enqueueMcpSave(policyPayload());
  return true;
};

const updateAllowedTools = (value) => {
  mcpConfig.value.allowedTools = Array.isArray(value)
    ? value.filter((tool) => MCP_ALLOWED_TOOL_OPTIONS.includes(tool))
    : [];
  if (mcpConfig.value.enabled) rollbackIncompletePolicy();
};

const loadMcpConfig = async () => {
  const api = electronApi();
  if (!api?.getMcpConfig) return { success: false, code: "API_UNAVAILABLE" };
  mcpLoading.value = true;
  mcpError.value = "";
  try {
    const result = await api.getMcpConfig();
    if (!result?.success) {
      mcpError.value = errorMessage(result?.code);
      return { success: false, code: result?.code };
    }
    applyingRemotePolicy = true;
    applyPolicy(result.data);
    applyingRemotePolicy = false;
    return { success: true };
  } catch (error) {
    mcpError.value = errorMessage(error?.code);
    return { success: false, code: error?.code };
  } finally {
    mcpLoading.value = false;
  }
};

const rollbackMcpAfterSaveFailure = (failureMessage, failureCode) => {
  if (!mcpConfig.value.enabled) return;

  suppressAutosave += 1;
  mcpSaveEpoch += 1;
  const rollbackConfig = {
    ...mcpConfig.value,
    enabled: false,
    // A deleted or untrusted root would make even the disabled snapshot fail
    // main-process canonicalization. Drop it so the fail-closed state persists.
    allowedRoots: failureCode === "MCP_ROOT_INVALID" ? [] : mcpConfig.value.allowedRoots,
  };
  mcpConfig.value = rollbackConfig;

  const rollbackMessage = `${failureMessage} MCP 已自动关闭，请修正策略后手动重新启用。`;
  mcpError.value = rollbackMessage;
  notifyAction("warning", rollbackMessage);
  void enqueueMcpSave(policyPayload()).finally(() => {
    if (!mcpConfig.value.enabled) mcpError.value = rollbackMessage;
  });
};

const saveMcpConfig = async (payload) => {
  const api = electronApi();
  if (!ensureElectronCapability() || !api?.saveMcpConfig) {
    return { success: false, code: "API_UNAVAILABLE" };
  }
  const snapshot = policyPayload(payload);
  mcpError.value = "";
  try {
    const result = await api.saveMcpConfig(snapshot);
    if (!result?.success) {
      const failureMessage = errorMessage(result?.code);
      mcpError.value = failureMessage;
      notifyAction("negative", failureMessage);
      if (result.data && typeof result.data === "object") {
        applyingRemotePolicy = true;
        try {
          applyPolicy(result.data);
        } finally {
          applyingRemotePolicy = false;
        }
        await store.refresh();
      } else if (snapshot.enabled === true && mcpConfig.value.enabled === true) {
        rollbackMcpAfterSaveFailure(failureMessage, result?.code);
      }
      return { success: false, code: result?.code || "MCP_CONFIG_SAVE_FAILED" };
    }
    if (result.data && areMcpPolicySnapshotsEqual(mcpConfig.value, snapshot)) {
      applyingRemotePolicy = true;
      try {
        applyPolicy(result.data);
      } finally {
        applyingRemotePolicy = false;
      }
    }
    const refreshResult = await store.refresh();
    if (refreshResult?.success) {
      return { success: true, data: result.data };
    } else {
      mcpError.value = store.error || "MCP 策略已保存，但运行状态刷新失败。";
      notifyAction("warning", mcpError.value);
      return { success: false, code: refreshResult?.code || "MCP_ACTIVITY_READ_FAILED", saved: true };
    }
  } catch (error) {
    const failureMessage = errorMessage(error?.code);
    mcpError.value = failureMessage;
    notifyAction("negative", failureMessage);
    if (error?.data && typeof error.data === "object") {
      applyingRemotePolicy = true;
      try {
        applyPolicy(error.data);
      } finally {
        applyingRemotePolicy = false;
      }
      await store.refresh();
    } else if (snapshot.enabled === true && mcpConfig.value.enabled === true) {
      rollbackMcpAfterSaveFailure(failureMessage, error?.code);
    }
    return { success: false, code: error?.code || "MCP_CONFIG_SAVE_FAILED" };
  } finally {
    // Queue ownership keeps the saving state active until every snapshot finishes.
  }
};

const scheduleMcpAutosave = () => {
  if (applyingRemotePolicy || suppressAutosave > 0 || !electronMcpAvailable.value) {
    suppressAutosave = Math.max(0, suppressAutosave - 1);
    return;
  }
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    void enqueueMcpSave();
  }, 360);
};

watch(mcpConfig, scheduleMcpAutosave, { deep: true });

const selectRoot = async () => {
  const api = electronApi();
  if (!ensureElectronCapability() || !api?.selectMcpRoot) return;
  mcpRootLoading.value = true;
  mcpError.value = "";
  try {
    const result = await api.selectMcpRoot();
    if (!result?.success) {
      mcpError.value = errorMessage(result?.code);
      notifyAction("negative", mcpError.value);
      return;
    }
    if (result.cancelled || typeof result.data !== "string") {
      notifyAction("info", "已取消选择允许目录。");
      return;
    }
    if (!mcpConfig.value.allowedRoots.includes(result.data)) {
      mcpConfig.value.allowedRoots.push(result.data);
      notifyAction("positive", "允许目录已加入，将自动保存并更新服务。");
    } else {
      notifyAction("info", "该目录已在允许列表中。");
    }
  } catch (error) {
    mcpError.value = errorMessage(error?.code);
    notifyAction("negative", mcpError.value);
  } finally {
    mcpRootLoading.value = false;
  }
};

const removeRoot = (root) => {
  mcpConfig.value.allowedRoots = mcpConfig.value.allowedRoots.filter((item) => item !== root);
  if (mcpConfig.value.enabled) rollbackIncompletePolicy();
};

const refreshAll = async ({ notifyResult = false } = {}) => {
  if (!ensureElectronCapability()) return { success: false, code: "API_UNAVAILABLE" };
  const [configResult, stateResult] = await Promise.all([loadMcpConfig(), store.refresh()]);
  const success = configResult?.success === true && stateResult?.success === true;
  if (notifyResult) {
    notifyAction(success ? "positive" : "negative", success ? "MCP 状态已刷新。" : panelErrorMessage.value || "MCP 状态刷新失败。");
  }
  return { success };
};

const copyText = async (value, successMessage) => {
  if (!value) return;
  try {
    await copyToClipboard(value);
    notifyAction("positive", successMessage);
  } catch {
    notifyAction("negative", "复制失败，请检查系统剪贴板权限。");
  }
};

const copyClientConfiguration = () => copyText(
  clientConfiguration.value.jsonTemplate,
  "MCP stdio 配置已复制。",
);
const copyClientCommand = () => copyText(clientCommand.value, "MCP 启动命令已复制。");

const probeExternalProxy = async () => {
  const api = electronApi();
  if (!externalApiAvailable.value || !api?.probeMcpExternalProxy) {
    notifyAction("warning", "当前应用尚未提供外部 stdio 代理。");
    return;
  }
  externalProbeLoading.value = true;
  externalProbeMessage.value = "";
  externalProbeFailed.value = false;
  try {
    const result = await api.probeMcpExternalProxy();
    const available = result?.success && result?.data?.available === true;
    externalProbeFailed.value = !available;
    externalProbeMessage.value = available
      ? "外部 stdio 代理可连接。"
      : result?.data?.code || result?.code || "外部 stdio 代理暂不可用。";
    notifyAction(available ? "positive" : "negative", externalProbeMessage.value);
  } catch {
    externalProbeFailed.value = true;
    externalProbeMessage.value = "外部 stdio 代理检查失败。";
    notifyAction("negative", externalProbeMessage.value);
  } finally {
    externalProbeLoading.value = false;
  }
};

const disconnectClientSession = async (session) => {
  const result = await store.disconnectClient(session?.sessionId);
  notifyAction(
    result?.success ? "positive" : "negative",
    result?.success ? session.clientName + " 已断开。" : "断开 MCP 客户端失败。",
  );
};

const refreshActivity = async ({ notifyResult = false } = {}) => {
  if (!ensureElectronCapability()) return;
  const result = await store.refresh();
  if (notifyResult || !result?.success) {
    notifyAction(
      result?.success ? "positive" : "negative",
      result?.success ? "MCP 活动日志已刷新。" : store.error || "MCP 活动日志刷新失败。",
    );
  }
  return result;
};

const openActivity = () => {
  if (activeSection.value === "activity") {
    void refreshActivity();
    return;
  }
  activeSection.value = "activity";
};

const startMcpService = async () => {
  if (!ensureElectronCapability()) return;
  if (rollbackIncompletePolicy()) return;
  suppressAutosave += 1;
  mcpConfig.value.enabled = true;
  mcpError.value = "";
  lifecycleIntent.value = "start";
  try {
    const result = await enqueueMcpSave(policyPayload());
    if (result?.success) notifyAction("positive", "MCP 服务已启动。");
  } finally {
    lifecycleIntent.value = "";
  }
};

const stopMcpService = async () => {
  if (!ensureElectronCapability()) return;
  suppressAutosave += 1;
  mcpConfig.value.enabled = false;
  mcpError.value = "";
  lifecycleIntent.value = "stop";
  try {
    const result = await enqueueMcpSave(policyPayload());
    if (result?.success) notifyAction("positive", "MCP 服务已停止。");
  } finally {
    lifecycleIntent.value = "";
  }
};

watch(
  () => [props.initialTab, props.navigationKey],
  ([value]) => {
    const nextSection = value === "activity" ? "activity" : "settings";
    if (activeSection.value !== nextSection) skipNextActivityRefresh = true;
    activeSection.value = nextSection;
    if (electronMcpAvailable.value) void refreshAll();
  },
);
watch(activeSection, (value, previousValue) => {
  if (skipNextActivityRefresh) {
    skipNextActivityRefresh = false;
    return;
  }
  if (value === "activity" && previousValue !== "activity") void refreshActivity();
});

onMounted(() => {
  if (electronMcpAvailable.value) {
    void refreshAll();
  }
});

onBeforeUnmount(() => {
  if (autosaveTimer) clearTimeout(autosaveTimer);
});
</script>

<style scoped>
.mcp-panel-heading { min-width: 0; }
.mcp-panel-heading__icon,
.mcp-card-heading__icon {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  color: var(--q-primary);
  background: rgba(138, 113, 212, 0.1);
  border: 1px solid rgba(138, 113, 212, 0.18);
}
.mcp-panel-heading__icon { width: 38px; height: 38px; border-radius: 11px; }
.mcp-panel-heading__copy { min-width: 0; }
.mcp-error-banner { display: flex; align-items: center; background: var(--settings-warning-surface, #fff4d7); color: var(--settings-warning-text, #735000); border: 1px solid var(--settings-warning-border, rgba(230, 172, 0, 0.28)); }
.mcp-capability-banner { background: var(--settings-info-surface, #e8efff); color: var(--settings-info-text, #233a7a); border-color: var(--settings-info-border, rgba(122, 141, 190, 0.22)); }
.mcp-status-strip {
  display: flex;
  min-height: 52px;
  align-items: center;
  gap: 12px;
  padding: 8px 10px 8px 14px;
  border: 1px solid var(--settings-border, rgba(17, 24, 39, .08));
  border-radius: 8px;
  background: var(--settings-field-surface, rgba(255, 255, 255, .55));
}
.mcp-status-indicator { width: 9px; height: 9px; flex: 0 0 auto; border-radius: 999px; background: #9ca3af; box-shadow: 0 0 0 4px rgba(156, 163, 175, .14); }
.mcp-status-indicator.is-running { background: #21ba45; box-shadow: 0 0 0 4px rgba(33, 186, 69, .14); }
.mcp-status-indicator.is-failed { background: #c10015; box-shadow: 0 0 0 4px rgba(193, 0, 21, .12); }
.mcp-status-copy { display: grid; min-width: 0; gap: 1px; }
.mcp-status-copy strong { font-size: 13px; line-height: 1.4; }
.mcp-status-copy span { overflow: hidden; color: var(--settings-text-secondary, rgba(17, 24, 39, .62)); font-size: 11px; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }
.mcp-status-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 2px; }
.mcp-lifecycle-button { min-width: 78px; min-height: 34px; margin-left: 4px; }
.mcp-section-tabs { border-bottom: 0; }
.mcp-section-panels { background: transparent; }
.mcp-module-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-areas: "client confirmation" "roots tools"; gap: 12px; align-items: start; }
.mcp-client-card { grid-area: client; }
.mcp-confirmation-card { grid-area: confirmation; }
.mcp-module-card:nth-of-type(3) { grid-area: roots; }
.mcp-module-card:nth-of-type(4) { grid-area: tools; }
.mcp-card-heading { display: flex; min-width: 0; align-items: center; gap: 10px; }
.mcp-card-heading > div:last-of-type { min-width: 0; }
.mcp-card-heading__icon { width: 32px; height: 32px; border-radius: 9px; }
.mcp-module-card { min-width: 0; padding: 14px; }
.mcp-client-preview :deep(textarea) { max-height: 124px; overflow-y: auto; }
.mcp-client-actions { display: flex; flex-wrap: wrap; gap: 4px; }
.mcp-inline-feedback { display: flex; align-items: center; gap: 6px; color: var(--q-positive); font-size: 12px; }
.mcp-inline-feedback.is-error { color: var(--q-negative); }
.mcp-session-list { display: grid; gap: 7px; }
.mcp-session-list__heading { display: flex; align-items: center; justify-content: space-between; color: var(--settings-text-secondary, rgba(17, 24, 39, .62)); font-size: 12px; }
.mcp-session-list__viewport { display: grid; max-height: 118px; gap: 4px; overflow-y: auto; }
.mcp-session-row { display: flex; min-width: 0; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--settings-border, rgba(17, 24, 39, .08)); border-radius: 7px; }
.mcp-session-row__copy { display: grid; min-width: 0; flex: 1; gap: 1px; }
.mcp-session-row__copy strong, .mcp-session-row__copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mcp-session-row__copy span { color: var(--settings-text-secondary, rgba(17, 24, 39, .62)); font-size: 11px; }
.mcp-confirmation-options { display: grid; gap: 3px; }
.mcp-confirmation-options :deep(.q-radio) { min-height: 48px; align-items: flex-start; padding: 7px 0; }
.mcp-confirmation-option__copy { display: grid; gap: 2px; padding-top: 1px; }
.mcp-confirmation-option__copy > div { overflow-wrap: anywhere; }
.mcp-tool-select :deep(.q-field__control) { min-height: 48px; }
.mcp-tool-select :deep(.q-field__native) { max-height: 112px; overflow-y: auto; }
.mcp-tool-option { min-height: 58px; }
.mcp-tool-option :deep(.q-item__label) { overflow-wrap: anywhere; }
.mcp-tool-chip { max-width: 100%; }
.mcp-tool-chip :deep(.q-chip__content) { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mcp-root-list { max-height: 148px; overflow: auto; border-radius: 8px; }
.mcp-root-path { overflow-wrap: anywhere; word-break: break-word; }
.mcp-activity-toolbar { display: flex; min-width: 0; align-items: center; gap: 12px; }
.mcp-activity-viewport { max-height: min(58vh, 620px); overflow: auto; padding-right: 2px; }
.mcp-empty-state {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 12px;
  border: 1px dashed var(--settings-border, rgba(17, 24, 39, .12));
  border-radius: 8px;
  color: var(--settings-text-secondary, rgba(17, 24, 39, .62));
  font-size: 12px;
  line-height: 1.45;
}
:global(.settings-card--dark) .mcp-panel-heading__icon,
:global(.settings-card--dark) .mcp-card-heading__icon {
  background: rgba(138, 113, 212, 0.18);
  border-color: rgba(138, 113, 212, 0.35);
}
:global(.settings-card--dark) .mcp-tool-option:hover { background: rgba(138, 113, 212, 0.14); }
:global(body.body--dark) .mcp-error-banner,
:global(.settings-card--dark) .mcp-error-banner {
  background: rgba(230, 172, 0, 0.18);
  color: #ffe1a0;
  border-color: rgba(230, 172, 0, 0.34);
}
:global(body.body--dark) .mcp-capability-banner,
:global(.settings-card--dark) .mcp-capability-banner {
  background: rgba(122, 141, 190, 0.2);
  color: #dce4ff;
  border-color: rgba(122, 141, 190, 0.34);
}
@media (max-width: 760px) {
  .mcp-module-grid { grid-template-columns: minmax(0, 1fr); grid-template-areas: "client" "confirmation" "roots" "tools"; }
  .mcp-status-copy span { white-space: normal; }
}
</style>
