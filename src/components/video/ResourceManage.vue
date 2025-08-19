<template>
  <div>
    <q-tabs
      v-model="tab"
      inline-label
      outside-arrows
      mobile-arrows
      class="bg-primary text-white shadow-2"
    >
      <q-tab name="masks" label="蒙版" />
      <q-tab name="videoFile" label="视频文件" />
    </q-tabs>
    <q-separator />
    <q-tab-panels v-model="tab" animated>
      <q-tab-panel name="masks">
        蒙版
      </q-tab-panel>

      <q-tab-panel name="videoFile">
        <div class="q-pa-md">
          <VideoUploaderButton />
        </div>
      </q-tab-panel>
    </q-tab-panels>
  </div>
</template>
<script setup>
import { ref } from "vue";
import VideoUploaderButton from './VideoUploaderButton.vue'

const tab = ref("masks");
</script>
