<template>
  <div class="row items-center">
    <div class="col">
      <q-badge :color="statusBadgeColor">
        {{ statusBadgeText }}
      </q-badge>
      <q-btn
        round
        dense
        flat
        size="xs"
        icon="help"
        color="grey-7"
        class="q-ml-xs"
      >
        <q-tooltip> 点击查看CUDA详细信息 </q-tooltip>
        <q-menu>
          <q-card style="min-width: 320px">
            <q-card-section class="row items-center q-pb-sm">
              <div class="text-h6">CUDA信息</div>
              <q-space />
              <q-btn
                flat
                round
                dense
                size="sm"
                icon="refresh"
                :loading="cudaRefreshing"
                :disable="!backendRunning"
                @click.stop="refreshCudaStatus"
              >
                <q-tooltip>刷新 CUDA 诊断</q-tooltip>
              </q-btn>
            </q-card-section>
            <q-card-section v-if="cudaInfo">
              <div class="q-mb-sm">
                <p><strong>运行包:</strong> {{ packageText }}</p>
                <p><strong>PyTorch CUDA:</strong> {{ cudaInfo.torch_cuda_version || "不可用" }}</p>
                <p><strong>CUDA 推理:</strong> {{ cudaInfo.torch_cuda_available ? "可用" : "不可用" }}</p>
                <p><strong>NVIDIA 驱动:</strong> {{ driverText }}</p>
                <p><strong>CUDA Toolkit:</strong> {{ toolkitText }}</p>
              </div>
              <div v-if="cudaAvailable">
                <p>
                  <strong>设备名称:</strong>
                  {{ cudaInfo.device_name }}
                </p>
                <p>
                  <strong>总显存:</strong>
                  {{ cudaInfo.total_memory_mb?.toFixed(2) }} MB
                </p>
                <p>
                  <strong>可用显存:</strong>
                  {{ cudaInfo.free_memory_mb?.toFixed(2) }} MB
                </p>
                <p v-if="cudaInfo.used_memory_mb != null">
                  <strong>已用显存:</strong>
                  {{ cudaInfo.used_memory_mb?.toFixed(2) }} MB
                </p>
              </div>
              <div v-else>
                <p>{{ cudaInfo.message || "CUDA不可用，将使用CPU进行处理" }}</p>
              </div>
              <p v-if="cudaInfo.toolkit_message" class="text-caption text-grey-7">
                {{ cudaInfo.toolkit_message }}
              </p>
              <p v-if="lastCheckedText" class="text-caption text-grey-7">
                {{ lastCheckedText }}
              </p>
            </q-card-section>
            <q-card-section v-else>
              <p>正在加载CUDA信息...</p>
            </q-card-section>
          </q-card>
        </q-menu>
      </q-btn>
    </div>
  </div>
</template>

<script setup>
import { computed, inject, onMounted, watch } from 'vue';
import { useRuntimeDiagnosticsStore } from "src/stores/runtimeDiagnostics";

const emit = defineEmits(['cuda-status-changed']);
const props = defineProps({
  backendRunning: {
    type: Boolean,
    default: false
  }
});

const runtimeDiagnosticsStore = useRuntimeDiagnosticsStore();
const runtimeDiagnostics = inject("runtimeDiagnostics", null);

const cudaAvailable = computed(() => runtimeDiagnosticsStore.cudaAvailable);
const cudaInfo = computed(() => runtimeDiagnosticsStore.cudaInfo);
const cudaRefreshing = computed(() => runtimeDiagnosticsStore.cudaRefreshing);

const emitCudaStatus = () => {
  emit('cuda-status-changed', {
    available: cudaAvailable.value,
    info: cudaInfo.value || {}
  });
};

const statusBadgeText = computed(() => {
  if (cudaInfo.value?.torch_package === "cpu") return "CPU 运行包";
  return `CUDA ${cudaAvailable.value ? "可用" : "不可用"}`;
});

const statusBadgeColor = computed(() => {
  if (cudaInfo.value?.torch_package === "cpu") return "grey-7";
  return cudaAvailable.value ? "positive" : "negative";
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
    console.error("刷新CUDA诊断时出错:", error);
    runtimeDiagnosticsStore.setCudaUnavailable("检测CUDA时发生错误");
    emitCudaStatus();
  }
};

// 监听后端状态变化
watch(() => props.backendRunning, (newVal) => {
  if (!newVal) {
    runtimeDiagnosticsStore.setCudaUnavailable("后端服务未启动");
  }
  emitCudaStatus();
});

onMounted(() => {
  emitCudaStatus();
});
</script>
