<!-- eslint-disable vue/multi-word-component-names -->
<template>
  <div
    class="workspace-shell relative"
    :class="{ 'workspace-shell--checkerboard': checkerboard }"
  >
    <div
      v-if="checkerboard"
      class="workspace-grid-shadow-layer"
      aria-hidden="true"
    ></div>
    <div class="workspace-content-layer">
      <slot v-if="hasContent" />
      <div v-else class="workspace-empty-state">
      <div class="workspace-empty-content">
        <!-- Logo 和声明标题的容器 -->
        <div class="workspace-logo-wrap column items-center">
          <!-- Logo -->
          <q-img
            :src="appAvatarImage"
            style="width: 128px; height: 128px; border-radius: 50%"
            class="q-mb-sm"
          />

          <!-- 声明标题 - 定位在LOGO下方并部分遮挡 -->
          <div
            class="workspace-disclaimer-tag text-h5 text-negative text-weight-bold"
            style="position: absolute; bottom: 10px; width: 100%; text-align: center; padding: 2px 15px; border-radius: 4px; z-index: 10;"
          >
            声明
          </div>
        </div>

        <!-- 免责声明内容 -->
        <q-card dark class="disclaimer-card q-pa-md">
          <q-card-section>
            <div class="text-warning">
              <p>1.使用者对本项目的使用由使用者自行决定，并自行承担风险。作者对使用者使用本项目所产生的任何损失、责任、或风险概不负责。</p>
              <p>2.本项目的作者提供的代码和功能是基于现有知识和技术开发的成果。作者尽力确保代码的正确性和安全性，但不保证代码完全没有错误或缺陷。</p>
              <p>3.使用者在使用本项目时必须严格遵守GNU General Public License v3.0的要求，并在适当的地方注明使用了GPLv3的代码。</p>
              <p>4.使用者在任何情况下均不得将本项目的作者、贡献者或其他相关方与使用者的使用行为联系起来，或要求其对使用者使用本项目所产生的任何损失或损害负责。</p>
              <p>5.使用者在使用本项目的代码和功能时，必须自行研究相关法律法规，并确保其使用行为合法合规。任何因违反法律法规而导致的法律责任和风险，均由使用者自行承担。</p>
              <p class="text-negative">6.本项目为基于GPLv3协议的开源项目，作者不会提供本项目的付费版本。</p>
              <p>7.基于本项目进行的任何二次开发、修改或编译的程序与原创作者无关，原创作者不承担与二次开发行为或其结果相关的任何责任，使用者应自行对因二次开发可能带来的各种情况负全部责任。</p>
              <p>在使用本项目的代码和功能之前，请您认真考虑并接受以上免责声明。</p>
              <p>如果您对上述声明有任何疑问或不同意，请不要使用本项目的代码和功能。</p>
              <p>如果您使用了本项目的代码和功能，则视为您已完全理解并接受上述免责声明，并自愿承担使用本项目的一切风险和后果。</p>
            </div>
          </q-card-section>
        </q-card>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

import appAvatarImage from "src/assets/branding/moonshine128x128.jpg";

const props = defineProps({
  selectedFile: {
    type: Object,
    default: null
  },
  checkerboard: {
    type: Boolean,
    default: false
  }
})

const hasContent = computed(() => {
  return !!props.selectedFile
})
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
  box-sizing: border-box;
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
  width: 150px;
  height: 150px;
  flex: 0 0 auto;
  margin-bottom: 24px;
}

.workspace-disclaimer-tag {
  background: rgba(255, 255, 255, 0.6);
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
  max-height: min(60vh, calc(100% - 190px));
  overflow-y: auto;
  flex: 0 1 auto;
  border-radius: 8px;
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
}

.disclaimer-card p {
  margin-bottom: 12px;
  line-height: 1.5;
}

@media (max-height: 820px) {
  .workspace-empty-state {
    padding: 20px;
  }

  .workspace-logo-wrap {
    margin-bottom: 18px;
  }

  .disclaimer-card {
    max-height: calc(100% - 170px);
  }
}
</style>
