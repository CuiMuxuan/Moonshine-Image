<template>
  <div>
    <!-- 最小化时的终端图标 -->
    <q-btn
      v-if="minimized"
      round
      color="primary"
      icon="terminal"
      class="terminal-icon"
      @click="toggleMinimize"
      :style="{
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        zIndex: 9999
      }"
    >
      <q-tooltip>点击查看终端输出</q-tooltip>
      <q-badge v-if="newMessages > 0" color="red" floating>{{ newMessages }}</q-badge>
    </q-btn>

    <!-- 终端弹窗 -->
    <q-dialog
      v-model="showDialog"
      persistent
      maximized
      class="terminal-dialog"
    >
      <q-card class="terminal-card">
        <q-card-section class="row items-center q-pb-none bg-dark text-white">
          <q-icon name="terminal" size="md" class="q-mr-sm" />
          <div class="text-h6">后端服务终端</div>
          <q-space />
          <q-btn
            icon="minimize"
            flat
            round
            dense
            @click="toggleMinimize"
            color="white"
            class="q-mr-sm"
          >
            <q-tooltip>最小化</q-tooltip>
          </q-btn>
          <q-btn
            icon="clear_all"
            flat
            round
            dense
            @click="clearTerminal"
            color="white"
            class="q-mr-sm"
          >
            <q-tooltip>清空终端</q-tooltip>
          </q-btn>
        </q-card-section>

        <q-card-section class="q-pa-none terminal-content">
          <div ref="terminalRef" class="terminal-output">
            <div
              v-for="(line, index) in terminalOutput"
              :key="index"
              :class="{
                'text-red': line.type === 'error',
                'text-yellow': line.type === 'warning',
                'text-green': line.type === 'success',
                'text-white': line.type === 'info',
              }"
              class="terminal-line"
            >
              <span class="text-grey-5">[{{ line.timestamp }}]</span>
              {{ line.message }}
            </div>
          </div>
        </q-card-section>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, nextTick, watch } from "vue";

const props = defineProps({
  modelValue: {
    type: Boolean,
    default: false,
  },
});

defineEmits(["update:modelValue"]);

const showDialog = ref(false);
const minimized = ref(false);
const terminalOutput = ref([]);
const terminalRef = ref(null);
const newMessages = ref(0);

// 监听显示状态
watch(
  () => props.modelValue,
  (newVal) => {
    if (newVal) {
      showDialog.value = true;
      minimized.value = false;
      newMessages.value = 0;
    } else {
      showDialog.value = false;
      minimized.value = false;
    }
  }
);

// 切换最小化状态
const toggleMinimize = () => {
  if (minimized.value) {
    showDialog.value = true;
    minimized.value = false;
    newMessages.value = 0;
  } else {
    showDialog.value = false;
    minimized.value = true;
  }
};

// 清空终端
const clearTerminal = () => {
  terminalOutput.value = [];
  addTerminalLog("终端已清空", "info");
};

// 添加终端日志
const addTerminalLog = (message, type = "info") => {
  const timestamp = new Date().toLocaleTimeString();
  terminalOutput.value.push({
    message,
    type,
    timestamp,
  });

  // 如果终端被最小化，增加新消息计数
  if (minimized.value) {
    newMessages.value++;
  }

  nextTick(() => {
    if (terminalRef.value) {
      terminalRef.value.scrollTop = terminalRef.value.scrollHeight;
    }
  });
};

// IPC 监听器处理后端输出
const handleBackendOutput = (event, data) => {
  addTerminalLog(data.message, data.type);
};

// 组件挂载时设置监听器
onMounted(() => {
  if (window.electron?.ipcRenderer) {
    window.electron.ipcRenderer.on("backend-output", handleBackendOutput);
  }
});

// 组件卸载时移除监听器
onUnmounted(() => {
  if (window.electron?.ipcRenderer) {
    window.electron.ipcRenderer.removeListener("backend-output", handleBackendOutput);
  }
});

// 暴露方法给父组件
defineExpose({
  addTerminalLog,
  clearTerminal,
});
</script>

<style scoped>
.terminal-dialog {
  z-index: 9998;
}

.terminal-card {
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.terminal-content {
  flex: 1;
  background-color: #1e1e1e;
  overflow: hidden;
}

.terminal-output {
  height: 100%;
  overflow-y: auto;
  padding: 16px;
  font-family: 'Courier New', monospace;
  font-size: 14px;
  line-height: 1.4;
  background-color: #1e1e1e;
}

.terminal-line {
  margin-bottom: 4px;
  word-wrap: break-word;
}

.terminal-icon {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}
</style>
