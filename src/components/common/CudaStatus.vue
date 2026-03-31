<template>
  <div class="row items-center">
    <div class="col">
      <q-badge :color="cudaAvailable ? 'positive' : 'negative'">
        CUDA {{ cudaAvailable ? "可用" : "不可用" }}
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
          <q-card style="min-width: 250px">
            <q-card-section>
              <div class="text-h6">CUDA信息</div>
            </q-card-section>
            <q-card-section v-if="cudaInfo">
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
              </div>
              <div v-else>
                <p>CUDA不可用，将使用CPU进行处理</p>
                <p>{{ cudaInfo.message || "无法获取详细信息" }}</p>
              </div>
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
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { useQuasar } from 'quasar';
import { api } from 'src/boot/axios';

const emit = defineEmits(['cuda-status-changed']);
const props = defineProps({
  backendRunning: {
    type: Boolean,
    default: false
  }
});

const $q = useQuasar();
const cudaAvailable = ref(false);
const cudaInfo = ref(null);
const checkInterval = ref(null);

// 检查CUDA可用性
const checkCUDAAvailability = async () => {
  // 只有在后端运行时才检查CUDA
  if (!props.backendRunning) {
    cudaAvailable.value = false;
    cudaInfo.value = { message: "后端服务未启动" };
    emit('cuda-status-changed', {
      available: false,
      info: { message: "后端服务未启动" }
    });
    return;
  }
  try {
    const response = await api.get("/api/v1/check_cuda");

    // 更新CUDA状态
    cudaAvailable.value = response.cuda_available;
    cudaInfo.value = response;

    emit('cuda-status-changed', {
      available: cudaAvailable.value,
      info: response
    });

    if (cudaAvailable.value) {
      $q.notify({
        type: "positive",
        message: `CUDA可用! 设备: ${response.device_name}`,
        position: "top",
        timeout: 3000,
      });
    }
  } catch (error) {
    console.error("检查CUDA可用性时出错:", error);
    cudaAvailable.value = false;
    cudaInfo.value = { message: "检测CUDA时发生错误" };

    emit('cuda-status-changed', {
      available: false,
      info: { message: "检测CUDA时发生错误" }
    });
  }
};

// 监听后端状态变化
watch(() => props.backendRunning, (newVal) => {
  if (newVal) {
    // 后端启动后延迟检查CUDA
    setTimeout(() => {
      checkCUDAAvailability();
    }, 2000);
  } else {
    // 后端停止时清除检查
    if (checkInterval.value) {
      clearInterval(checkInterval.value);
      checkInterval.value = null;
    }
    cudaAvailable.value = false;
    cudaInfo.value = { message: "后端服务未启动" };
  }
});

// 组件挂载时检查CUDA可用性
onMounted(() => {
  if (props.backendRunning) {
    setTimeout(() => {
      checkCUDAAvailability();
    }, 1000);
  }
});

// 组件卸载时清理
onUnmounted(() => {
  if (checkInterval.value) {
    clearInterval(checkInterval.value);
  }
});
</script>
