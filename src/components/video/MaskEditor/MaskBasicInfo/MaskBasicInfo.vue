<template>
  <div class="mask-basic-info">
    <div class="info-section">
      <div class="section-title">基本信息</div>

      <div class="info-item">
        <label>蒙版名称</label>
        <q-input
          v-model="localMaskName"
          dense
          outlined
          @blur="updateMaskName"
          @keyup.enter="updateMaskName"
        />
      </div>

      <div class="info-item">
        <label>蒙版颜色</label>
        <div class="color-picker-container">
          <div
            class="color-preview"
            :style="{ backgroundColor: localMaskColor }"
            @click="showColorPicker = !showColorPicker"
          ></div>
          <q-popup-proxy v-model="showColorPicker">
            <q-color
              v-model="localMaskColor"
              @change="updateMaskColor"
            />
          </q-popup-proxy>
        </div>
      </div>

      <div class="info-item">
        <label>可见性</label>
        <q-toggle
          v-model="localMaskVisible"
          @update:model-value="updateMaskVisibility"
        />
      </div>
    </div>

    <div class="info-section">
      <div class="section-title">时间范围</div>

      <TimeRange :mask="mask" />
    </div>

    <div class="info-section">
      <div class="section-title">蒙版类型</div>

      <q-select
        v-model="localMaskType"
        :options="maskTypeOptions"
        outlined
        dense
        @update:model-value="updateMaskType"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { useVideoHandleManager } from 'src/stores/videoHandleManager'
import TimeRange from './TimeRange.vue'

const props = defineProps({
  mask: {
    type: Object,
    required: true
  }
})

const videoStore = useVideoHandleManager()
const { updateMask } = videoStore

const showColorPicker = ref(false)
const localMaskName = ref(props.mask.name)
const localMaskColor = ref(props.mask.color)
const localMaskVisible = ref(props.mask.visible)
const localMaskType = ref(props.mask.type || 'rectangle')

const maskTypeOptions = [
  { label: '矩形', value: 'rectangle' },
  { label: '圆形', value: 'circle' },
  { label: '椭圆', value: 'ellipse' },
  { label: '多边形', value: 'polygon' }
]

// 监听mask变化，更新本地状态
watch(() => props.mask, (newMask) => {
  localMaskName.value = newMask.name
  localMaskColor.value = newMask.color
  localMaskVisible.value = newMask.visible
  localMaskType.value = newMask.type || 'rectangle'
}, { deep: true })

function updateMaskName() {
  if (localMaskName.value !== props.mask.name) {
    updateMask(props.mask.id, {
      ...props.mask,
      name: localMaskName.value
    })
  }
}

function updateMaskColor() {
  updateMask(props.mask.id, {
    ...props.mask,
    color: localMaskColor.value
  })
}

function updateMaskVisibility() {
  updateMask(props.mask.id, {
    ...props.mask,
    visible: localMaskVisible.value
  })
}

function updateMaskType() {
  updateMask(props.mask.id, {
    ...props.mask,
    type: localMaskType.value
  })
}
</script>

<style scoped>
.mask-basic-info {
  padding: 16px;
}

.info-section {
  margin-bottom: 24px;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: #333;
  margin-bottom: 12px;
  padding-bottom: 4px;
  border-bottom: 1px solid #e0e0e0;
}

.info-item {
  margin-bottom: 12px;
}

.info-item label {
  display: block;
  font-size: 12px;
  color: #666;
  margin-bottom: 4px;
}

.color-picker-container {
  display: flex;
  align-items: center;
}

.color-preview {
  width: 32px;
  height: 32px;
  border-radius: 4px;
  border: 2px solid #e0e0e0;
  cursor: pointer;
  transition: border-color 0.2s ease;
}

.color-preview:hover {
  border-color: #2196f3;
}
</style>
