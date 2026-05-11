<template>
  <div
    ref="rootRef"
    v-show="show"
    class="toolbar-container mask-toolbar-region app-floating-toolbar"
    :style="toolbarStyle"
    @mousedown.stop
    @pointerdown.stop
  >
    <div
      class="toolbar-handle bg-primary text-white text-center text-xs py-1 cursor-move"
      @pointerdown.stop.prevent="$emit('drag-start', $event)"
    >
      {{ dragLabel }}
    </div>

    <q-bar class="q-px-md rounded-b-pill app-floating-toolbar-bar" :style="floatingToolbarBarStyle">
      <MaskBrushControls
        :drawing-enabled="drawingEnabled"
        :mode="mode"
        :brush-size="brushSize"
        :brush-color="brushColor"
        :brush-alpha="brushAlpha"
        :can-undo="canUndo"
        :can-clear="canClear"
        :disabled="disabled"
        :button-size="toolbarButtonSize"
        :content-class="contentClass"
        :popup-anchor="popupAnchor"
        :popup-self="popupSelf"
        :transition-show="transitionShow"
        :transition-hide="transitionHide"
        @toggle-drawing="$emit('toggle-drawing')"
        @update:mode="$emit('update:mode', $event)"
        @update:brush-size="$emit('update:brush-size', $event)"
        @update:brush-color="$emit('update:brush-color', $event)"
        @update:brush-alpha="$emit('update:brush-alpha', $event)"
        @undo="$emit('undo')"
        @clear="$emit('clear')"
      >
        <template #after="{ buttonSize, textColor }">
          <q-btn-group flat class="toolbar-side-actions">
            <q-btn icon="center_focus_strong" :size="buttonSize" :text-color="textColor" @click="$emit('reset-view')">
              <q-tooltip>{{ resetViewTooltip }}</q-tooltip>
            </q-btn>
            <q-btn
              icon="visibility_off"
              :size="buttonSize"
              :text-color="textColor"
              @mousedown="$emit('hold-mask-visibility', false)"
              @mouseup="$emit('hold-mask-visibility', true)"
              @mouseleave="$emit('hold-mask-visibility', true)"
              @touchstart.prevent="$emit('hold-mask-visibility', false)"
              @touchend.prevent="$emit('hold-mask-visibility', true)"
              @touchcancel.prevent="$emit('hold-mask-visibility', true)"
            >
              <q-tooltip>{{ holdHideMaskTooltip }}</q-tooltip>
            </q-btn>
          </q-btn-group>
        </template>
      </MaskBrushControls>
    </q-bar>
  </div>
</template>

<script setup>
import { computed, ref } from "vue";
import { useQuasar } from "quasar";

import MaskBrushControls from "src/components/common/MaskBrushControls.vue";
import { normalizeButtonSize } from "src/config/ConfigManager";
import { useConfigStore } from "src/stores/config";

const props = defineProps({
  show: {
    type: Boolean,
    default: false,
  },
  position: {
    type: Object,
    default: () => ({ x: 24, y: 24 }),
  },
  zIndex: {
    type: [Number, String],
    default: 1001,
  },
  dragLabel: {
    type: String,
    default: "绘制工具拖动区域",
  },
  drawingEnabled: {
    type: Boolean,
    default: false,
  },
  mode: {
    type: String,
    default: "draw",
  },
  brushSize: {
    type: Number,
    default: 20,
  },
  brushColor: {
    type: String,
    default: "#8a71d4",
  },
  brushAlpha: {
    type: Number,
    default: 0.75,
  },
  canUndo: {
    type: Boolean,
    default: false,
  },
  canClear: {
    type: Boolean,
    default: true,
  },
  disabled: {
    type: Boolean,
    default: false,
  },
  contentClass: {
    type: String,
    default: "",
  },
  popupAnchor: {
    type: String,
    default: "bottom middle",
  },
  popupSelf: {
    type: String,
    default: "top middle",
  },
  transitionShow: {
    type: String,
    default: "jump-down",
  },
  transitionHide: {
    type: String,
    default: "jump-up",
  },
  resetViewTooltip: {
    type: String,
    default: "重置视图",
  },
  holdHideMaskTooltip: {
    type: String,
    default: "按住隐藏蒙版",
  },
});

defineEmits([
  "drag-start",
  "toggle-drawing",
  "update:mode",
  "update:brush-size",
  "update:brush-color",
  "update:brush-alpha",
  "undo",
  "clear",
  "reset-view",
  "hold-mask-visibility",
]);

const $q = useQuasar();
const configStore = useConfigStore();
const rootRef = ref(null);

const toolbarButtonSize = computed(() => normalizeButtonSize(configStore.config.ui?.buttonSize));
const floatingToolbarShellStyle = computed(() => ({
  borderColor: $q.dark.isActive ? "rgba(255, 255, 255, 0.1)" : "rgba(17, 24, 39, 0.08)",
  background: $q.dark.isActive ? "rgba(24, 24, 27, 0.94)" : "rgba(255, 255, 255, 0.92)",
  color: $q.dark.isActive ? "rgba(244, 244, 245, 0.94)" : "rgba(17, 24, 39, 0.9)",
}));
const floatingToolbarBarStyle = computed(() => ({
  background: "transparent",
  color: $q.dark.isActive ? "rgba(244, 244, 245, 0.94)" : "rgba(17, 24, 39, 0.9)",
}));
const toolbarStyle = computed(() => ({
  left: `${Number(props.position?.x || 0)}px`,
  top: `${Number(props.position?.y || 0)}px`,
  zIndex: Number(props.zIndex || 1001),
  ...floatingToolbarShellStyle.value,
}));

defineExpose({
  getRootElement: () => rootRef.value || null,
});
</script>

<style scoped>
.toolbar-container {
  z-index: 1001 !important;
  pointer-events: auto !important;
  position: absolute !important;
  touch-action: none;
  user-select: none;
  overflow: visible;
  width: max-content;
  max-width: none;
}

.toolbar-handle {
  cursor: move !important;
  border-top-left-radius: 20px;
  border-top-right-radius: 20px;
  letter-spacing: 0.02em;
}

.app-floating-toolbar {
  border-radius: 20px !important;
  border: 1px solid rgba(17, 24, 39, 0.08);
  box-shadow: 0 14px 36px rgba(15, 23, 42, 0.18);
  backdrop-filter: blur(14px);
  background: rgba(255, 255, 255, 0.9);
}

:global(body.body--dark) .app-floating-toolbar {
  border-color: rgba(255, 255, 255, 0.08);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.35);
  background: rgba(24, 24, 27, 0.88);
}

.rounded-b-pill {
  border-bottom-left-radius: 20px !important;
  border-bottom-right-radius: 20px !important;
}

.app-floating-toolbar-bar {
  border: none !important;
  background: transparent !important;
  min-height: 54px;
}

.toolbar-side-actions :deep(.q-btn) {
  color: rgba(17, 24, 39, 0.88);
}

:global(body.body--dark) .toolbar-side-actions :deep(.q-btn) {
  color: rgba(244, 244, 245, 0.94);
}
</style>
