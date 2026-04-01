<!-- eslint-disable vue/multi-word-component-names -->
<template>
  <div class="workspace-shell relative" :class="{ 'workspace-shell--checkerboard': checkerboard }">
    <div v-if="checkerboard" class="workspace-grid-shadow-layer" aria-hidden="true"></div>
    <div class="workspace-content-layer">
      <slot v-if="hasContent" />
      <div v-else class="workspace-empty-state">
        <div class="workspace-empty-content">
          <div class="workspace-logo-wrap column items-center">
            <q-img :src="appAvatarImage" style="width: 148px; height: 148px; border-radius: 50%" class="q-mb-sm" />
            <div class="workspace-disclaimer-tag text-h5 text-negative text-weight-bold">
              声明
            </div>
          </div>

          <q-card dark class="disclaimer-card q-pa-md">
            <q-card-section class="text-warning">
              <p>1. 本项目仅供学习与研究使用，使用者需自行判断用途并承担全部风险。</p>
              <p>2. 作者会尽力保证代码的可用性与安全性，但不对任何直接或间接损失承担责任。</p>
              <p>3. 使用、修改、分发本项目时，请遵守 GPLv3 及相关开源协议要求。</p>
              <p>4. 使用者应自行确认当地法律法规与平台规则，确保实际使用行为合法合规。</p>
              <p>5. 基于本项目进行的二次开发、修改或编译结果，由二次开发者自行负责。</p>
              <p class="text-negative">6. 本项目基于 GPLv3 开源协议发布，作者不会提供本项目的付费版本。</p>
              <p>继续使用本项目即表示你已阅读并接受以上说明。</p>
            </q-card-section>
          </q-card>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from "vue";
import { resolvePublicAssetPath } from "src/utils/publicAsset";

const props = defineProps({
  selectedFile: {
    type: Object,
    default: null,
  },
  checkerboard: {
    type: Boolean,
    default: false,
  },
});

const appAvatarImage = resolvePublicAssetPath("images/moonshine300x300.jpg");
const hasContent = computed(() => Boolean(props.selectedFile));
</script>

<style scoped>
.workspace-shell {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.workspace-shell--checkerboard {
  --workspace-grid-cell-a: var(--preview-grid-cell-a, #161616);
  --workspace-grid-cell-b: var(--preview-grid-cell-b, #202020);
  background-image: conic-gradient(
    from 45deg,
    var(--workspace-grid-cell-a) 0deg 90deg,
    var(--workspace-grid-cell-b) 90deg 180deg,
    var(--workspace-grid-cell-a) 180deg 270deg,
    var(--workspace-grid-cell-b) 270deg 360deg
  );
  background-size: 20px 20px;
  background-position: 0 0;
  background-color: var(--workspace-grid-cell-a);
}

.workspace-grid-shadow-layer {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0)),
    radial-gradient(circle at 50% 38%, rgba(255, 255, 255, 0.04), transparent 58%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.04),
    inset 0 22px 44px rgba(0, 0, 0, 0.14),
    inset 0 -24px 48px rgba(0, 0, 0, 0.18);
}

.workspace-content-layer {
  position: relative;
  z-index: 1;
  display: flex;
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.workspace-empty-state {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding: 24px;
  overflow: hidden;
  color: #6b7280;
}

.workspace-empty-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: min(100%, 840px);
  max-width: 100%;
  height: 100%;
  min-height: 0;
}

.workspace-logo-wrap {
  position: relative;
  width: 170px;
  height: 170px;
  flex: 0 0 auto;
  margin-bottom: 24px;
}

.workspace-disclaimer-tag {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 8px;
  padding: 2px 15px;
  text-align: center;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.6);
  z-index: 10;
}

:global(body.body--dark) .workspace-empty-state {
  color: rgba(212, 212, 216, 0.88);
}

:global(body.body--dark) .workspace-disclaimer-tag {
  background: rgba(17, 24, 39, 0.58);
}

.disclaimer-card {
  width: min(100%, 800px);
  max-width: 800px;
  max-height: min(60vh, calc(100% - 210px));
  overflow-y: auto;
  border-radius: 8px;
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
}

.disclaimer-card p {
  margin-bottom: 12px;
  line-height: 1.5;
}
</style>
