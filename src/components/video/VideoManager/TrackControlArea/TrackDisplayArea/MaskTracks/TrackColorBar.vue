<template>
  <div
    class="track-color-bar"
    :style="{ backgroundColor: color }"
  ></div>
</template>

<script setup>
defineProps({
  color: {
    type: String,
    default: '#4CAF50'
  }
})
</script>

<style scoped>
.track-color-bar {
  width: 4px;
  height: 24px;
  border-radius: 2px;
  margin-right: 8px;
}
</style>
