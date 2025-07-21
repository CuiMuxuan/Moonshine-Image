<template>
  <div class="keyframe-transform">
    <q-card flat bordered>
      <q-card-section>
        <div class="text-h6">变换参数</div>
      </q-card-section>

      <q-card-section>
        <div class="transform-controls">
          <div class="control-group">
            <q-input
              v-model.number="localTransform.offsetX"
              label="X轴偏移"
              type="number"
              outlined
              dense
              :step="0.01"
              @update:model-value="onTransformChange"
            />

            <q-input
              v-model.number="localTransform.offsetY"
              label="Y轴偏移"
              type="number"
              outlined
              dense
              :step="0.01"
              @update:model-value="onTransformChange"
            />
          </div>

          <div class="control-group">
            <q-input
              v-model.number="localTransform.scaleX"
              label="X轴缩放"
              type="number"
              outlined
              dense
              :step="0.01"
              :min="0.1"
              :max="5"
              @update:model-value="onTransformChange"
            />

            <q-input
              v-model.number="localTransform.scaleY"
              label="Y轴缩放"
              type="number"
              outlined
              dense
              :step="0.01"
              :min="0.1"
              :max="5"
              @update:model-value="onTransformChange"
            />
          </div>

          <q-btn
            color="grey-7"
            label="重置"
            @click="onReset"
            class="full-width"
          />
        </div>
      </q-card-section>
    </q-card>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'

const props = defineProps({
  keyframe: {
    type: Object,
    required: true
  }
})

const emit = defineEmits(['transform-update'])

const localTransform = ref({
  offsetX: 0,
  offsetY: 0,
  scaleX: 1,
  scaleY: 1
})

function onTransformChange() {
  emit('transform-update', { ...localTransform.value })
}

function onReset() {
  localTransform.value = {
    offsetX: 0,
    offsetY: 0,
    scaleX: 1,
    scaleY: 1
  }
  onTransformChange()
}

watch(() => props.keyframe, (newKeyframe) => {
  if (newKeyframe?.transform) {
    localTransform.value = { ...newKeyframe.transform }
  } else {
    localTransform.value = {
      offsetX: 0,
      offsetY: 0,
      scaleX: 1,
      scaleY: 1
    }
  }
}, { immediate: true })
</script>

<style scoped>
.transform-controls {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.control-group {
  display: flex;
  gap: 12px;
}
</style>
