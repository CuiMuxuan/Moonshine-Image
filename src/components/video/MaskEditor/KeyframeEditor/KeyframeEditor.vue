<template>
  <div class="keyframe-editor">
    <div class="editor-header">
      <div class="section-title">关键帧编辑</div>

      <div class="keyframe-controls">
        <q-btn
          size="sm"
          icon="add"
          label="添加关键帧"
          @click="addKeyframe"
          :disable="hasKeyframeAtCurrentTime"
        />
        <q-btn
          size="sm"
          icon="delete"
          label="删除关键帧"
          @click="deleteCurrentKeyframe"
          :disable="!currentKeyframe || isFirstOrLastKeyframe"
        />
      </div>
    </div>

    <div class="keyframe-list-container">
      <KeyframeList
        :mask="mask"
        :current-time="currentTime"
        @keyframe-select="onKeyframeSelect"
        @keyframe-delete="onKeyframeDelete"
      />
    </div>

    <div v-if="currentKeyframe" class="keyframe-transform">
      <div class="section-title">变换属性</div>

      <KeyframeTransform
        :keyframe="currentKeyframe"
        @transform-update="onTransformUpdate"
      />
    </div>

    <div v-else class="no-keyframe-selected">
      <q-icon name="info" size="24px" color="grey-5" />
      <p class="text-grey-6">请选择一个关键帧进行编辑</p>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useVideoHandleManager } from 'src/stores/videoHandleManager'
import KeyframeList from './KeyframeList.vue'
import KeyframeTransform from './KeyframeTransform.vue'

const props = defineProps({
  mask: {
    type: Object,
    required: true
  }
})

const videoStore = useVideoHandleManager()
const { currentTime, selectedKeyframeIndex } = storeToRefs(videoStore)
const { addKeyframeAtCurrentTime, updateMask } = videoStore

const currentKeyframe = computed(() => {
  if (selectedKeyframeIndex.value >= 0 && selectedKeyframeIndex.value < props.mask.keyframes.length) {
    return props.mask.keyframes[selectedKeyframeIndex.value]
  }
  return null
})

const hasKeyframeAtCurrentTime = computed(() => {
  return props.mask.keyframes.some(
    kf => Math.abs(kf.time - currentTime.value) < 0.1
  )
})

const isFirstOrLastKeyframe = computed(() => {
  if (!currentKeyframe.value) return false
  const sortedKeyframes = [...props.mask.keyframes].sort((a, b) => a.time - b.time)
  const currentIndex = sortedKeyframes.findIndex(kf => kf === currentKeyframe.value)
  return currentIndex === 0 || currentIndex === sortedKeyframes.length - 1
})

function addKeyframe() {
  addKeyframeAtCurrentTime(props.mask.id)
}

function deleteCurrentKeyframe() {
  if (!currentKeyframe.value || isFirstOrLastKeyframe.value) return

  const updatedKeyframes = props.mask.keyframes.filter(
    kf => kf !== currentKeyframe.value
  )

  updateMask(props.mask.id, {
    ...props.mask,
    keyframes: updatedKeyframes
  })

  selectedKeyframeIndex.value = Math.max(0, selectedKeyframeIndex.value - 1)
}

function onKeyframeSelect(index) {
  selectedKeyframeIndex.value = index
}

function onKeyframeDelete(index) {
  const keyframeToDelete = props.mask.keyframes[index]
  if (!keyframeToDelete) return

  // 检查是否为首尾关键帧
  const sortedKeyframes = [...props.mask.keyframes].sort((a, b) => a.time - b.time)
  const sortedIndex = sortedKeyframes.findIndex(kf => kf === keyframeToDelete)

  if (sortedIndex === 0 || sortedIndex === sortedKeyframes.length - 1) {
    return // 不允许删除首尾关键帧
  }

  const updatedKeyframes = props.mask.keyframes.filter((_, i) => i !== index)

  updateMask(props.mask.id, {
    ...props.mask,
    keyframes: updatedKeyframes
  })

  if (selectedKeyframeIndex.value >= index) {
    selectedKeyframeIndex.value = Math.max(0, selectedKeyframeIndex.value - 1)
  }
}

function onTransformUpdate(transform) {
  if (!currentKeyframe.value) return

  const updatedKeyframes = props.mask.keyframes.map(kf => {
    if (kf === currentKeyframe.value) {
      return {
        ...kf,
        transform: { ...kf.transform, ...transform }
      }
    }
    return kf
  })

  updateMask(props.mask.id, {
    ...props.mask,
    keyframes: updatedKeyframes
  })
}
</script>

<style scoped>
.keyframe-editor {
  padding: 16px;
}

.editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: #333;
  margin-bottom: 12px;
  padding-bottom: 4px;
  border-bottom: 1px solid #e0e0e0;
}

.keyframe-controls {
  display: flex;
  gap: 8px;
}

.keyframe-list-container {
  margin-bottom: 24px;
  max-height: 200px;
  overflow-y: auto;
}

.no-keyframe-selected {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px;
  color: #999;
  text-align: center;
}

.no-keyframe-selected p {
  margin: 8px 0 0 0;
  font-size: 14px;
}
</style>
