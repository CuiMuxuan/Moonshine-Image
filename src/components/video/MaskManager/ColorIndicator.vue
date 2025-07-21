<template>
  <q-avatar
    :style="{ backgroundColor: color }"
    size="24px"
    class="color-indicator"
  >
    <q-icon name="layers" color="white" size="12px" />
  </q-avatar>
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
.color-indicator {
  border: 2px solid white;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}
</style>
