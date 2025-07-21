<template>
  <q-input
    v-model="localName"
    label="蒙版名称"
    outlined
    dense
    @update:model-value="onNameChange"
  />
</template>

<script setup>
import { ref, watch } from 'vue'
import { useVideoHandleManager } from 'src/stores/videoHandleManager'

const props = defineProps({
  mask: {
    type: Object,
    required: true
  }
})

const videoStore = useVideoHandleManager()
const localName = ref(props.mask.name)

function onNameChange(newName) {
  const updatedMask = { ...props.mask, name: newName }
  videoStore.updateMask(props.mask.id, updatedMask)
}

watch(() => props.mask.name, (newName) => {
  localName.value = newName
})
</script>
