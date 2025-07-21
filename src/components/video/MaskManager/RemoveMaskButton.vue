
<template>
  <q-btn
    flat
    dense
    round
    icon="delete"
    size="sm"
    color="negative"
    @click.stop="onRemove"
  >
    <q-tooltip>删除蒙版</q-tooltip>
  </q-btn>
</template>

<script setup>
defineProps({
  maskId: {
    type: String,
    required: true
  }
})

const emit = defineEmits(['remove'])

function onRemove() {
  emit('remove')
}
</script>
