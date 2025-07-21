<template>
  <div class="mask-editor">
    <div class="mask-editor-header">
      <h6 class="q-ma-none">蒙版编辑</h6>
    </div>

    <div v-if="activeMask" class="mask-editor-content">
      <MaskBasicInfo :mask="activeMask" />
      <KeyframeEditor :mask="activeMask" />
    </div>

    <div v-else class="no-mask-selected">
      <q-icon name="info" size="48px" color="grey-5" />
      <p class="text-grey-6">请选择一个蒙版进行编辑</p>
    </div>
  </div>
</template>
<script setup>
import { storeToRefs } from 'pinia'
import { useVideoHandleManager } from '../../../stores/videoHandleManager'
import MaskBasicInfo from './MaskBasicInfo/MaskBasicInfo.vue'
import KeyframeEditor from './KeyframeEditor/KeyframeEditor.vue'

const videoHandleManager = useVideoHandleManager()
const { activeMask } = storeToRefs(videoHandleManager)
</script>
