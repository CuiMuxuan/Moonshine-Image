<template>
  <div class="cuda-status" data-testid="cuda-status">
    <q-badge
      :color="statusBadgeColor"
      class="cuda-status__badge"
      rounded
      role="status"
      aria-live="polite"
    >
      <q-icon :name="statusIcon" size="14px" class="q-mr-xs" />
      {{ statusBadgeText }}
    </q-badge>
    <q-btn
      round
      dense
      flat
      size="xs"
      icon="info_outline"
      color="grey-7"
      class="cuda-status__info-button q-ml-xs"
      aria-label="查看 CUDA 运行环境诊断"
    >
      <q-tooltip>查看 CUDA 运行环境诊断</q-tooltip>
      <q-menu anchor="bottom right" self="top right" class="cuda-status__menu">
        <q-card class="cuda-status__card">
          <q-card-section class="cuda-status__header">
            <div class="cuda-status__heading">
              <div class="cuda-status__header-icon" aria-hidden="true">
                <q-icon name="memory" size="20px" />
              </div>
              <div>
                <div class="cuda-status__title">CUDA 运行环境</div>
                <div class="cuda-status__subtitle">{{ statusSummary }}</div>
              </div>
            </div>
            <q-btn
              flat
              round
              dense
              size="sm"
              icon="refresh"
              :loading="cudaRefreshing"
              :disable="!backendRunning"
              aria-label="刷新 CUDA 诊断"
              @click.stop="refreshCudaStatus"
            >
              <q-tooltip>刷新 CUDA 诊断</q-tooltip>
            </q-btn>
          </q-card-section>
          <q-separator />
          <q-card-section v-if="cudaInfo" class="cuda-status__content">
            <div
              class="cuda-status__summary"
              :class="`cuda-status__summary--${diagnosticTone}`"
              role="status"
              aria-live="polite"
            >
              <q-icon :name="diagnosticIcon" size="20px" />
              <div>
                <div class="cuda-status__summary-title">{{ diagnosticTitle }}</div>
                <div class="cuda-status__summary-text">{{ diagnosticDescription }}</div>
              </div>
            </div>

            <div class="cuda-status__metric-grid" aria-label="CUDA 技术信息">
              <div class="cuda-status__metric">
                <span>运行包</span>
                <strong>{{ packageText }}</strong>
              </div>
              <div class="cuda-status__metric">
                <span>PyTorch CUDA</span>
                <strong>{{ cudaInfo.torch_cuda_version || "不可用" }}</strong>
              </div>
              <div class="cuda-status__metric">
                <span>NVIDIA 驱动</span>
                <strong>{{ driverText }}</strong>
              </div>
              <div class="cuda-status__metric">
                <span>CUDA Toolkit</span>
                <strong>{{ toolkitText }}</strong>
              </div>
            </div>

            <div v-if="cudaAvailable" class="cuda-status__device">
              <div class="cuda-status__device-heading">
                <q-icon name="developer_board" size="17px" />
                <span>可用设备</span>
              </div>
              <div class="cuda-status__device-name">{{ cudaInfo.device_name || "未提供设备名称" }}</div>
              <div class="cuda-status__memory-grid">
                <div>
                  <span>总显存</span>
                  <strong>{{ formatMemory(cudaInfo.total_memory_mb) }}</strong>
                </div>
                <div>
                  <span>可用显存</span>
                  <strong>{{ formatMemory(cudaInfo.free_memory_mb) }}</strong>
                </div>
                <div v-if="cudaInfo.used_memory_mb != null">
                  <span>已用显存</span>
                  <strong>{{ formatMemory(cudaInfo.used_memory_mb) }}</strong>
                </div>
              </div>
            </div>
            <div v-else class="cuda-status__message" role="status" aria-live="polite">
              <q-icon name="info" size="17px" />
              <span>{{ cudaInfo.message || "CUDA 不可用，将使用 CPU 进行处理。" }}</span>
            </div>

            <div v-if="cudaInfo.toolkit_message" class="cuda-status__footnote">
              {{ cudaInfo.toolkit_message }}
            </div>
            <div v-if="lastCheckedText" class="cuda-status__footnote">{{ lastCheckedText }}</div>
          </q-card-section>
          <q-card-section v-else class="cuda-status__empty" role="status" aria-live="polite">
            <q-spinner-dots color="primary" size="24px" />
            <span>正在加载 CUDA 诊断信息...</span>
          </q-card-section>
        </q-card>
      </q-menu>
    </q-btn>
  </div>
</template>

<script setup>
import { computed, inject, onMounted, watch } from "vue";
import { useRuntimeDiagnosticsStore } from "src/stores/runtimeDiagnostics";

const emit = defineEmits(["cuda-status-changed"]);
const props = defineProps({
  backendRunning: {
    type: Boolean,
    default: false,
  },
});

const runtimeDiagnosticsStore = useRuntimeDiagnosticsStore();
const runtimeDiagnostics = inject("runtimeDiagnostics", null);

const cudaAvailable = computed(() => runtimeDiagnosticsStore.cudaAvailable);
const cudaInfo = computed(() => runtimeDiagnosticsStore.cudaInfo);
const cudaRefreshing = computed(() => runtimeDiagnosticsStore.cudaRefreshing);

const emitCudaStatus = () => {
  emit("cuda-status-changed", {
    available: cudaAvailable.value,
    info: cudaInfo.value || {},
  });
};

const statusBadgeText = computed(() => {
  if (cudaInfo.value?.torch_package === "cpu") return "CPU 运行包";
  return `CUDA ${cudaAvailable.value ? "可用" : "不可用"}`;
});

const statusBadgeColor = computed(() => {
  if (cudaInfo.value?.torch_package === "cpu") return "secondary";
  return cudaAvailable.value ? "positive" : "negative";
});

const statusIcon = computed(() => {
  if (cudaInfo.value?.torch_package === "cpu") return "memory";
  return cudaAvailable.value ? "check_circle" : "error_outline";
});

const statusSummary = computed(() => {
  if (!cudaInfo.value) return "等待后端诊断结果";
  if (cudaInfo.value.torch_package === "cpu") return "当前使用 CPU PyTorch，不调用显卡";
  return cudaAvailable.value ? "PyTorch CUDA 与设备均可用" : "CUDA 运行条件未满足";
});

const packageText = computed(() =>
  cudaInfo.value?.torch_package === "cuda" ? "CUDA 运行包" : "CPU 运行包"
);

const driverText = computed(() => {
  if (!cudaInfo.value?.nvidia_driver_available) return "未检测到";
  return cudaInfo.value.nvidia_driver_version || "已检测到";
});

const toolkitText = computed(() => {
  if (!cudaInfo.value?.nvcc_available) return "未检测到 nvcc";
  return cudaInfo.value.nvcc_version || "已检测到 nvcc";
});

const diagnosticTone = computed(() => {
  if (cudaInfo.value?.torch_package === "cpu") return "neutral";
  return cudaAvailable.value ? "positive" : "negative";
});

const diagnosticIcon = computed(() => {
  if (diagnosticTone.value === "neutral") return "info";
  return diagnosticTone.value === "positive" ? "check_circle" : "warning";
});

const diagnosticTitle = computed(() => {
  if (diagnosticTone.value === "neutral") return "已切换为 CPU 模式";
  return diagnosticTone.value === "positive" ? "CUDA 已就绪" : "CUDA 暂不可用";
});

const diagnosticDescription = computed(() => {
  if (diagnosticTone.value === "neutral") {
    return "当前环境可以正常运行 CPU 模型；显卡驱动或 CUDA 版本不满足时不会阻塞普通模型。";
  }
  return cudaInfo.value?.message || (cudaAvailable.value
    ? "当前 PyTorch 可以使用检测到的 NVIDIA 设备。"
    : "请检查 PyTorch CUDA、NVIDIA 驱动与设备兼容性。");
});

const formatMemory = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? `${amount.toFixed(2)} MB` : "未提供";
};

const lastCheckedText = computed(() => {
  const checkedAt = Number(runtimeDiagnosticsStore.cudaStatus.checkedAt || 0);
  if (!checkedAt) return "";
  return `最后检测：${new Date(checkedAt).toLocaleTimeString()}`;
});

const refreshCudaStatus = async () => {
  if (!props.backendRunning || !runtimeDiagnostics?.refreshCudaDiagnostics) return;
  try {
    await runtimeDiagnostics.refreshCudaDiagnostics({ force: true, notify: true });
    emitCudaStatus();
  } catch (error) {
    console.error("刷新 CUDA 诊断时出错:", error);
    runtimeDiagnosticsStore.setCudaUnavailable("检测 CUDA 时发生错误");
    emitCudaStatus();
  }
};

watch(() => props.backendRunning, (newValue) => {
  if (!newValue) runtimeDiagnosticsStore.setCudaUnavailable("服务未启动");
  emitCudaStatus();
});

onMounted(() => {
  emitCudaStatus();
});
</script>

<style scoped>
.cuda-status {
  display: inline-flex;
  align-items: center;
  min-width: 0;
}

.cuda-status__badge {
  min-height: 24px;
  padding: 0 9px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0;
}

.cuda-status__info-button {
  color: var(--settings-text-secondary, #6b7280);
}

.cuda-status__menu {
  max-width: min(430px, calc(100vw - 24px));
}

.cuda-status__card {
  width: min(430px, calc(100vw - 24px));
  max-width: 100%;
  border: 1px solid rgba(123, 93, 214, 0.16);
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(35, 24, 78, 0.16);
}

.cuda-status__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
}

.cuda-status__heading {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 10px;
}

.cuda-status__header-icon {
  display: grid;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 10px;
  color: #6d4fd3;
  background: #f1edff;
}

.cuda-status__title {
  color: #202124;
  font-size: 14px;
  font-weight: 700;
}

.cuda-status__subtitle {
  margin-top: 2px;
  color: #6b7280;
  font-size: 11px;
  line-height: 1.35;
}

.cuda-status__content {
  display: grid;
  gap: 12px;
  padding: 14px 16px 16px;
}

.cuda-status__summary {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 10px 11px;
  border: 1px solid transparent;
  border-radius: 10px;
}

.cuda-status__summary--positive {
  color: #176b4a;
  background: #edf9f2;
  border-color: #bfe9cf;
}

.cuda-status__summary--neutral {
  color: #4b5563;
  background: #f4f5f7;
  border-color: #e3e6eb;
}

.cuda-status__summary--negative {
  color: #a52b38;
  background: #fff1f2;
  border-color: #f3c4ca;
}

.cuda-status__summary-title {
  font-size: 12px;
  font-weight: 700;
}

.cuda-status__summary-text {
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.45;
}

.cuda-status__metric-grid,
.cuda-status__memory-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.cuda-status__metric,
.cuda-status__memory-grid > div {
  min-width: 0;
  padding: 9px 10px;
  border-radius: 9px;
  background: #f7f7f9;
}

.cuda-status__metric span,
.cuda-status__memory-grid span {
  display: block;
  color: #737782;
  font-size: 10px;
  line-height: 1.3;
}

.cuda-status__metric strong,
.cuda-status__memory-grid strong {
  display: block;
  margin-top: 3px;
  overflow-wrap: anywhere;
  color: #26272b;
  font-size: 12px;
  line-height: 1.4;
}

.cuda-status__device {
  padding: 11px;
  border: 1px solid #e9e8ef;
  border-radius: 10px;
}

.cuda-status__device-heading {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #555861;
  font-size: 11px;
  font-weight: 700;
}

.cuda-status__device-name {
  margin: 6px 0 9px;
  overflow-wrap: anywhere;
  color: #25262a;
  font-size: 13px;
  font-weight: 600;
}

.cuda-status__message,
.cuda-status__empty {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  color: #676b73;
  font-size: 11px;
  line-height: 1.5;
}

.cuda-status__empty {
  align-items: center;
  padding: 18px 16px;
}

.cuda-status__footnote {
  color: #7a7e87;
  font-size: 10px;
  line-height: 1.45;
}

:global(body.body--dark) .cuda-status__card {
  border-color: rgba(174, 154, 238, 0.26);
  background: #2b2b2f;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.34);
}

:global(body.body--dark) .cuda-status__header-icon {
  color: #d7ccff;
  background: rgba(145, 116, 228, 0.2);
}

:global(body.body--dark) .cuda-status__title,
:global(body.body--dark) .cuda-status__metric strong,
:global(body.body--dark) .cuda-status__memory-grid strong,
:global(body.body--dark) .cuda-status__device-name {
  color: rgba(255, 255, 255, 0.9);
}

:global(body.body--dark) .cuda-status__subtitle,
:global(body.body--dark) .cuda-status__metric span,
:global(body.body--dark) .cuda-status__memory-grid span,
:global(body.body--dark) .cuda-status__message,
:global(body.body--dark) .cuda-status__empty,
:global(body.body--dark) .cuda-status__footnote {
  color: rgba(255, 255, 255, 0.62);
}

:global(body.body--dark) .cuda-status__metric,
:global(body.body--dark) .cuda-status__memory-grid > div {
  background: rgba(255, 255, 255, 0.07);
}

:global(body.body--dark) .cuda-status__device {
  border-color: rgba(255, 255, 255, 0.14);
}

:global(body.body--dark) .cuda-status__device-heading {
  color: rgba(255, 255, 255, 0.76);
}

:global(body.body--dark) .cuda-status__summary--positive {
  color: #a9e6c3;
  background: rgba(23, 107, 74, 0.3);
  border-color: rgba(92, 202, 143, 0.3);
}

:global(body.body--dark) .cuda-status__summary--neutral {
  color: rgba(255, 255, 255, 0.78);
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.14);
}

:global(body.body--dark) .cuda-status__summary--negative {
  color: #ffc5ca;
  background: rgba(165, 43, 56, 0.3);
  border-color: rgba(243, 119, 130, 0.3);
}

@media (max-width: 480px) {
  .cuda-status__metric-grid,
  .cuda-status__memory-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
