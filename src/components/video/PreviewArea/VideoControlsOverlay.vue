<template>
  <div class="video-controls-overlay" @click="$emit('click')">
    <div class="play-button" v-if="!isPlaying">
      <q-icon name="play_arrow" size="48px" color="white" />
    </div>
  </div>
</template>

<script setup>
defineProps({
  isPlaying: {
    type: Boolean,
    default: false
  }
})

defineEmits(['click'])
</script>

<style scoped>
.video-controls-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.3);
  opacity: 0;
  transition: opacity 0.3s ease;
  cursor: pointer;
}

.video-controls-overlay:hover {
  opacity: 1;
}

.play-button {
  background: rgba(0, 0, 0, 0.7);
  border-radius: 50%;
  padding: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
