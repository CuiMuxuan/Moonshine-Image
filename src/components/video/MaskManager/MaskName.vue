<template>
  <q-item-label class="mask-name">
    {{ name }}
  </q-item-label>
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
.mask-name {
  font-weight: 500;
  color: #333;
}
</style>
