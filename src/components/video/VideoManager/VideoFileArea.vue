<template>
  <div>
    <ControlButtons />
    <FileInfoDisplay />
    <ProcessingControls />
  </div>
</template>

<script setup>
import ControlButtons from './ControlButtons.vue'; // 实现上传/处理/下载按钮
import FileInfoDisplay from './FileInfoDisplay.vue'; // 实现CurrentFileInfo和TargetFileInfo
import ProcessingControls from './ProcessingControls.vue'; // 实现视频处理相关控件
</script>
