<template>
  <q-item
    clickable
    :class="{
      'mask-item': true,
      'mask-item--active': isActive,
      'mask-item--selected': isSelected
    }"
    @click="onItemClick"
  >
    <q-item-section avatar>
      <ColorIndicator :color="mask.color" />
    </q-item-section>

    <q-item-section>
      <div class="mask-header">
        <q-checkbox
          :model-value="isSelected"
          @update:model-value="onToggleSelection"
          @click.stop
        />
        <MaskName :name="mask.name" />
      </div>
      <q-item-label caption>
        {{ formatTimeRange(mask.startTime, mask.endTime) }}
        <span class="keyframe-count">{{ mask.keyframes.length }} 关键帧</span>
      </q-item-label>
    </q-item-section>

    <q-item-section side>
      <div class="mask-actions">
        <Thumbnail :mask="mask" />
        <RemoveMaskButton :mask-id="mask.id" @remove="onRemove" />
      </div>
    </q-item-section>
  </q-item>
</template>

<script setup>
import { computed } from 'vue'
import { useVideoHandleManager } from 'src/stores/videoHandleManager'
import ColorIndicator from './ColorIndicator.vue'
import MaskName from './MaskName.vue'
import Thumbnail from './MaskThumbnail.vue'
import RemoveMaskButton from './RemoveMaskButton.vue'

const props = defineProps({
  mask: {
    type: Object,
    required: true
  }
})

const emit = defineEmits(['select', 'remove'])

const videoStore = useVideoHandleManager()
const { selectedMaskIds, activeMaskId } = videoStore

const isActive = computed(() => activeMaskId === props.mask.id)
const isSelected = computed(() => selectedMaskIds.has(props.mask.id))

function formatTimeRange(startTime, endTime) {
  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }
  return `${formatTime(startTime)} - ${formatTime(endTime)}`
}

function onItemClick() {
  videoStore.onMaskSelect(props.mask.id)
  emit('select', props.mask.id)
}

function onToggleSelection() {
  videoStore.toggleMaskSelection(props.mask.id)
}

function onRemove() {
  emit('remove', props.mask.id)
}
</script>

<style scoped>
.mask-item {
  border-radius: 8px;
  margin-bottom: 4px;
  transition: all 0.2s ease;
}

.mask-item:hover {
  background-color: rgba(0, 0, 0, 0.04);
}

.mask-item--active {
  background-color: rgba(25, 118, 210, 0.08);
  border-left: 3px solid #1976d2;
}

.mask-item--selected {
  background-color: rgba(25, 118, 210, 0.04);
}

.mask-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.keyframe-count {
  margin-left: 8px;
  color: #999;
}

.mask-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
</style>
