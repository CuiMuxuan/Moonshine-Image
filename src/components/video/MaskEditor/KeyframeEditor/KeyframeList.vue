<template>
  <div class="keyframe-list">
    <q-list>
      <q-item
        v-for="(keyframe, index) in mask.keyframes"
        :key="index"
        clickable
        :class="{
          'keyframe-item': true,
          'keyframe-item--active': Math.abs(currentTime - keyframe.time) < 0.1
        }"
        @click="onSelectKeyframe(index)"
      >
        <q-item-section avatar>
          <q-icon name="radio_button_checked" color="primary" />
        </q-item-section>

        <q-item-section>
          <q-item-label>关键帧 {{ index + 1 }}</q-item-label>
          <q-item-label caption>
            时间: {{ formatTime(keyframe.time) }}
          </q-item-label>
        </q-item-section>

        <q-item-section side v-if="mask.keyframes.length > 2">
          <q-btn
            flat
            dense
            round
            icon="delete"
            size="sm"
            color="negative"
            @click.stop="onRemoveKeyframe(index)"
          />
        </q-item-section>
      </q-item>
    </q-list>
  </div>
</template>

<script setup>
import { storeToRefs } from 'pinia'
import { useVideoHandleManager } from 'src/stores/videoHandleManager'

const props = defineProps({
  mask: {
    type: Object,
    required: true
  }
})

const emit = defineEmits(['keyframe-select', 'keyframe-delete'])

const videoStore = useVideoHandleManager()
const { currentTime } = storeToRefs(videoStore)
const { onSeek, formatTime } = videoStore

function onSelectKeyframe(index) {
  emit('keyframe-select', index)

  // 跳转到关键帧时间
  const keyframe = props.mask.keyframes[index]
  if (keyframe) {
    onSeek(keyframe.time)
  }
}

function onRemoveKeyframe(index) {
  emit('keyframe-delete', index)
}
</script>

<style scoped>
.keyframe-list {
  max-height: 200px;
  overflow-y: auto;
}

.keyframe-item {
  border-radius: 4px;
  margin-bottom: 2px;
}

.keyframe-item--active {
  background-color: rgba(25, 118, 210, 0.08);
}
</style>
