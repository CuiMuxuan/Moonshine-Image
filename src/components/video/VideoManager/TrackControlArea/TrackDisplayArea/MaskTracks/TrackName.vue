<template>
  <div class="track-name">
    {{ name }}
  </div>
</template>

<script setup>
defineProps({
  name: {
    type: String,
    required: true
  }
})
</script>

<style scoped>
.track-name {
  font-size: 12px;
  font-weight: 500;
  color: #333;
  min-width: 80px;
  margin-right: 8px;
}
</style>
