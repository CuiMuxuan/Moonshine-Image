<template>
  <div class="mask-manager">
    <div class="mask-manager-header">
      <h6 class="q-ma-none">蒙版管理</h6>
      <div class="header-actions">
        <q-btn
          flat
          dense
          icon="select_all"
          @click="onSelectAll"
          :disable="!hasMasks"
        >
          <q-tooltip>全选</q-tooltip>
        </q-btn>

        <q-btn
          flat
          dense
          icon="deselect"
          @click="onClearSelection"
          :disable="!hasSelectedMasks"
        >
          <q-tooltip>取消选择</q-tooltip>
        </q-btn>

        <q-btn
          flat
          dense
          icon="content_copy"
          @click="onDuplicateSelected"
          :disable="!hasSelectedMasks"
        >
          <q-tooltip>复制选中</q-tooltip>
        </q-btn>

        <q-btn
          flat
          dense
          icon="delete"
          @click="onRemoveSelected"
          :disable="!hasSelectedMasks"
          color="negative"
        >
          <q-tooltip>删除选中</q-tooltip>
        </q-btn>
      </div>
    </div>

    <div class="mask-list-container">
      <q-list v-if="hasMasks">
        <MaskItem
          v-for="mask in maskList"
          :key="mask.id"
          :mask="mask"
          :is-selected="selectedMaskIds.has(mask.id)"
          @select="onMaskSelect"
          @toggle-selection="onToggleSelection"
          @remove="onRemoveMask"
        />
      </q-list>

      <div v-else class="empty-state">
        <q-icon name="layers" size="48px" color="grey-4" />
        <p class="text-grey-6">暂无蒙版</p>
        <q-btn
          color="primary"
          label="添加蒙版"
          @click="onAddMask"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useVideoHandleManager } from '../../../stores/videoHandleManager'
import MaskItem from './MaskItem.vue'

const videoHandleManager = useVideoHandleManager()
const { maskList, selectedMaskIds, hasSelectedMasks } = storeToRefs(videoHandleManager)
const {
  selectAllMasks,
  clearMaskSelection,
  removeSelectedMasks,
  duplicateSelectedMasks,
  toggleMaskSelection,
  onMaskSelect,
  removeMask
} = videoHandleManager

const hasMasks = computed(() => maskList.value.length > 0)

function onSelectAll() {
  selectAllMasks.value()
}

function onClearSelection() {
  clearMaskSelection.value()
}

function onDuplicateSelected() {
  duplicateSelectedMasks.value()
}

function onRemoveSelected() {
  removeSelectedMasks.value()
}

function onToggleSelection(maskId) {
  toggleMaskSelection.value(maskId)
}

function onRemoveMask(maskId) {
  removeMask.value(maskId)
}

function onAddMask() {
  // 实现添加蒙版逻辑
  console.log('添加新蒙版')
}
</script>

<style scoped>
.mask-manager {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.mask-manager-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid #e0e0e0;
}

.header-actions {
  display: flex;
  gap: 4px;
}

.mask-list-container {
  flex: 1;
  overflow-y: auto;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 200px;
  text-align: center;
  gap: 16px;
}
</style>
