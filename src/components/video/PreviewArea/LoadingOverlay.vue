<template>
  <div class="loading-overlay">
    <q-spinner-dots size="48px" color="white" />
    <div class="loading-text">加载中...</div>
  </div>
</template>

<script setup>
// 无需额外逻辑
</script>

<style scoped>
.loading-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.loading-text {
  color: white;
  margin-top: 16px;
  font-size: 14px;
}
</style>
