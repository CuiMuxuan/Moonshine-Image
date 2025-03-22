<template>
  <q-input
    :model-value="modelValue"
    :label="label"
    filled
    readonly
    stack-label
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <template v-slot:append>
      <q-btn round dense flat icon="folder" @click="selectFolder" />
    </template>
  </q-input>
</template>

<script setup>
import { useQuasar } from "quasar";

const $q = useQuasar();
const props = defineProps({
  modelValue: {
    type: String,
    default: "",
  },
  label: {
    type: String,
    default: "选择文件夹",
  },
});

const emit = defineEmits(["update:modelValue"]);

const selectFolder = async () => {
  try {
    // 检查是否在 Electron 环境中
    if (window.electron) {
      // 使用 Electron 的 dialog API 选择文件夹
      const result = await window.electron.ipcRenderer.invoke(
        "select-directory"
      );
      if (!result.canceled && result.filePaths.length > 0) {
        emit("update:modelValue", result.filePaths[0]);
        return; // 成功选择文件夹后直接返回，不执行后续代码
      }
    }

    // 如果不在 Electron 环境中或选择被取消，尝试使用 Web API
    else if ("showDirectoryPicker" in window) {
      const directoryHandle = await window.showDirectoryPicker();
      emit("update:modelValue", directoryHandle.name); // 只能获取文件夹名称，不是完整路径
    } else {
      // 回退到模拟对话框
      $q.dialog({
        title: "选择文件夹路径",
        message: "您的浏览器不支持文件夹选择功能",
        prompt: {
          model: props.modelValue,
          type: "text",
        },
        cancel: true,
        persistent: true,
      }).onOk((data) => {
        emit("update:modelValue", data);
      });
    }
  } catch (err) {
    console.error("选择文件夹出错:", err);
    $q.notify({
      type: "negative",
      message: "选择文件夹失败",
      position: "top",
    });
  }
};
</script>
