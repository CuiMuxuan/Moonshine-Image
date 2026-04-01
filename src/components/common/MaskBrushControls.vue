<template>
  <div
    class="mask-brush-controls"
    :class="{
      'is-disabled': disabled,
      'is-dark': $q.dark.isActive,
      'layout-video-sidebar': layout === 'video-sidebar',
    }"
    :style="controlsStyle"
  >
    <div class="slot-before">
      <slot name="before"></slot>
    </div>

    <div class="tool-main-group">
      <q-btn
        :color="drawingEnabled ? 'positive' : 'negative'"
        text-color="white"
        :icon="drawingEnabled ? 'toggle_on' : 'toggle_off'"
        :disable="disabled"
        :size="resolvedButtonSize"
        class="control-button control-button-drawing"
        @click="$emit('toggle-drawing')"
      >
        <q-tooltip>{{ drawingEnabled ? "关闭绘制" : "开启绘制" }}</q-tooltip>
      </q-btn>

      <q-btn-group flat class="mode-toggle">
        <q-btn
          v-for="option in modeOptions"
          :key="option.value"
          :color="mode === option.value ? 'primary' : inactiveButtonColor"
          :text-color="mode === option.value ? 'white' : secondaryTextColor"
          :icon="option.icon"
          :disable="disabled"
          :size="resolvedButtonSize"
          class="mode-button"
          @click="$emit('update:mode', option.value)"
        >
          <q-tooltip>{{ option.label }}</q-tooltip>
        </q-btn>
      </q-btn-group>

      <q-btn
        color="primary"
        text-color="white"
        icon="tune"
        :disable="disabled"
        :size="resolvedButtonSize"
        class="control-button control-button-settings"
      >
        <q-tooltip>画笔设置</q-tooltip>

        <q-menu
          :anchor="popupAnchor"
          :self="popupSelf"
          :offset="popupOffset"
          :content-class="menuContentClass"
          :transition-show="transitionShow"
          :transition-hide="transitionHide"
        >
          <div class="brush-settings-panel q-pa-md">
            <div class="brush-preview-wrap">
              <div class="brush-preview-surface">
                <div
                  class="brush-preview-shape"
                  :class="{
                    'is-rect': mode === MASK_TOOL_MODES.RECT,
                    'is-erase': mode === MASK_TOOL_MODES.ERASE,
                  }"
                  :style="brushPreviewStyle"
                ></div>
              </div>
              <div class="brush-preview-caption text-caption text-center q-mt-sm">
                {{ modeLabel }}预览
              </div>
            </div>

            <div class="brush-settings-fields">
              <div class="brush-color-field">
                <div class="brush-field-label text-caption q-mb-xs">画笔颜色</div>
                <label class="brush-color-input">
                  <input
                    :value="brushColor"
                    :disabled="disabled"
                    type="color"
                    @input="$emit('update:brush-color', $event.target.value)"
                  />
                </label>
              </div>

              <q-slider
                :model-value="brushSize"
                :disable="disabled"
                :min="1"
                :max="120"
                :step="1"
                label
                label-always
                @update:model-value="$emit('update:brush-size', $event)"
              >
                <template #prepend>画笔大小</template>
              </q-slider>

              <q-slider
                :model-value="brushAlpha"
                :disable="disabled"
                :min="0.05"
                :max="1"
                :step="0.05"
                label
                label-always
                @update:model-value="$emit('update:brush-alpha', $event)"
              >
                <template #prepend>画笔透明度</template>
              </q-slider>
            </div>
          </div>
        </q-menu>
      </q-btn>
    </div>

    <q-btn-group flat class="rounded-pill overflow-hidden control-group">
      <q-btn
        icon="undo"
        :disable="disabled || !canUndo"
        :size="resolvedButtonSize"
        :text-color="secondaryTextColor"
        @click="$emit('undo')"
      >
        <q-tooltip>撤回</q-tooltip>
      </q-btn>
      <q-btn
        icon="clear"
        :disable="disabled || !canClear"
        :size="resolvedButtonSize"
        :text-color="secondaryTextColor"
        @click="$emit('clear')"
      >
        <q-tooltip>清空蒙版</q-tooltip>
      </q-btn>
    </q-btn-group>

    <div class="slot-after">
      <slot name="after" :button-size="resolvedButtonSize" :text-color="secondaryTextColor"></slot>
    </div>
  </div>
</template>

<script setup>
import { computed } from "vue";
import { useQuasar } from "quasar";

import {
  DEFAULT_UI_BUTTON_SIZE,
  normalizeButtonSize,
} from "src/config/ConfigManager";
import { MASK_TOOL_MODES, MASK_TOOL_MODE_OPTIONS, hexToRgba } from "src/utils/maskTool";

const props = defineProps({
  drawingEnabled: {
    type: Boolean,
    default: false,
  },
  mode: {
    type: String,
    default: MASK_TOOL_MODES.DRAW,
  },
  brushSize: {
    type: Number,
    default: 20,
  },
  brushColor: {
    type: String,
    default: "#1976D2",
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
  buttonSize: {
    type: String,
    default: DEFAULT_UI_BUTTON_SIZE,
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
  popupOffset: {
    type: Array,
    default: () => [0, 12],
  },
  transitionShow: {
    type: String,
    default: "jump-down",
  },
  transitionHide: {
    type: String,
    default: "jump-up",
  },
  layout: {
    type: String,
    default: "default",
  },
});

defineEmits([
  "toggle-drawing",
  "update:mode",
  "update:brush-size",
  "update:brush-color",
  "update:brush-alpha",
  "undo",
  "clear",
]);

const $q = useQuasar();

const modeOptions = MASK_TOOL_MODE_OPTIONS.map((option) => ({
  ...option,
}));

const resolvedButtonSize = computed(() => normalizeButtonSize(props.buttonSize));
const inactiveButtonColor = computed(() => ($q.dark.isActive ? "grey-8" : "grey-6"));
const secondaryTextColor = computed(() => ($q.dark.isActive ? "grey-2" : "grey-8"));
const menuContentClass = computed(() =>
  ["mask-brush-settings-popup", props.contentClass].filter(Boolean).join(" ")
);

const controlsStyle = computed(() => {
  const minWidthMap = {
    md: 560,
    sm: 520,
    xs: 476,
  };

  if (props.layout === "video-sidebar") {
    return {
      "--mask-controls-min-width": "0px",
    };
  }

  return {
    "--mask-controls-min-width": `${minWidthMap[resolvedButtonSize.value] || minWidthMap.md}px`,
  };
});

const modeLabel = computed(() => {
  const matched = MASK_TOOL_MODE_OPTIONS.find((option) => option.value === props.mode);
  return matched?.label || "画笔";
});

const brushPreviewStyle = computed(() => {
  const size = Math.max(14, Math.min(72, Number(props.brushSize || 0)));
  const alpha = Math.max(0.05, Math.min(1, Number(props.brushAlpha || 0)));

  if (props.mode === MASK_TOOL_MODES.ERASE) {
    return {
      width: `${size}px`,
      height: `${size}px`,
    };
  }

  return {
    width: `${size}px`,
    height: `${size}px`,
    background: hexToRgba(props.brushColor, alpha),
  };
});
</script>

<style scoped>
.mask-brush-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: nowrap;
  width: max-content;
  min-width: var(--mask-controls-min-width, 560px);
  max-width: none;
}

.mask-brush-controls.layout-video-sidebar {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  container-type: inline-size;
}

.slot-before,
.slot-after {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.slot-before {
  order: 4;
}

.slot-after {
  order: 3;
}

.slot-before:empty,
.slot-after:empty {
  display: none;
}

.mask-brush-controls.is-disabled {
  opacity: 0.72;
}

.tool-main-group {
  display: flex;
  align-items: stretch;
  flex-wrap: nowrap;
  flex: 1 1 auto;
  min-width: 0;
  border-radius: 999px;
  overflow: hidden;
}

.control-group {
  min-height: 42px;
  flex: 0 0 auto;
}

.control-button {
  min-height: 42px;
}

.control-button-drawing {
  border-top-right-radius: 0 !important;
  border-bottom-right-radius: 0 !important;
}

.control-button-settings {
  border-top-left-radius: 0 !important;
  border-bottom-left-radius: 0 !important;
}

.mode-toggle {
  min-width: 180px;
  flex: 1 1 auto;
  display: flex;
  align-items: stretch;
}

.mode-button {
  flex: 1 1 0;
  min-width: 56px;
  min-height: 42px;
}

.mode-button :deep(.q-icon img) {
  width: 20px;
  height: 20px;
}

@container (max-width: 560px) {
  .mask-brush-controls.layout-video-sidebar {
    gap: 6px;
    flex-wrap: wrap;
  }

  .mask-brush-controls.layout-video-sidebar .tool-main-group {
    flex: 1 1 100%;
    width: 100%;
  }

  .mask-brush-controls.layout-video-sidebar .control-group,
  .mask-brush-controls.layout-video-sidebar .slot-after,
  .mask-brush-controls.layout-video-sidebar .slot-before {
    margin-left: auto;
  }

  .mask-brush-controls.layout-video-sidebar .mode-toggle {
    min-width: 0;
  }

  .mask-brush-controls.layout-video-sidebar .control-group,
  .mask-brush-controls.layout-video-sidebar .control-button,
  .mask-brush-controls.layout-video-sidebar .mode-button {
    min-height: 38px;
  }

  .mask-brush-controls.layout-video-sidebar .mode-button {
    min-width: 46px;
  }

  .mask-brush-controls.layout-video-sidebar .mode-button :deep(.q-icon img) {
    width: 18px;
    height: 18px;
  }

  .mask-brush-controls.layout-video-sidebar :deep(.q-btn) {
    padding-left: 10px;
    padding-right: 10px;
  }
}

@container (max-width: 420px) {
  .mask-brush-controls.layout-video-sidebar .control-group,
  .mask-brush-controls.layout-video-sidebar .control-button,
  .mask-brush-controls.layout-video-sidebar .mode-button {
    min-height: 36px;
  }

  .mask-brush-controls.layout-video-sidebar .mode-button {
    min-width: 42px;
  }

  .mask-brush-controls.layout-video-sidebar :deep(.q-btn) {
    padding-left: 8px;
    padding-right: 8px;
  }
}

:global(.mask-brush-settings-popup) {
  border-radius: 20px;
  border: 1px solid rgba(17, 24, 39, 0.08);
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 18px 40px rgba(15, 23, 42, 0.18);
  backdrop-filter: blur(14px);
  overflow: hidden;
}

:global(body.body--dark .mask-brush-settings-popup) {
  border-color: rgba(255, 255, 255, 0.08);
  background: rgba(24, 24, 27, 0.96);
  box-shadow: 0 20px 42px rgba(0, 0, 0, 0.4);
  color: rgba(244, 244, 245, 0.94);
}

.brush-settings-panel {
  display: grid;
  grid-template-columns: 132px minmax(260px, 320px);
  gap: 16px;
  max-width: calc(100vw - 32px);
}

.brush-preview-wrap {
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.brush-preview-surface {
  min-height: 132px;
  border-radius: 16px;
  border: 1px solid rgba(17, 24, 39, 0.08);
  background-image:
    linear-gradient(45deg, rgba(148, 163, 184, 0.18) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(148, 163, 184, 0.18) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(148, 163, 184, 0.18) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(148, 163, 184, 0.18) 75%);
  background-size: 20px 20px;
  background-position: 0 0, 0 10px, 10px -10px, -10px 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

:global(body.body--dark) .brush-preview-surface {
  border-color: rgba(255, 255, 255, 0.08);
  background-image:
    linear-gradient(45deg, rgba(255, 255, 255, 0.06) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(255, 255, 255, 0.06) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(255, 255, 255, 0.06) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(255, 255, 255, 0.06) 75%);
  background-color: rgba(39, 39, 42, 0.88);
}

.brush-preview-shape {
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.92);
  box-shadow: 0 0 0 1px rgba(17, 24, 39, 0.16);
}

.brush-preview-shape.is-rect {
  border-radius: 12px;
}

.brush-preview-shape.is-erase {
  background: rgba(255, 255, 255, 0.9);
  border-color: rgba(17, 24, 39, 0.65);
  box-shadow: 0 0 0 1px rgba(17, 24, 39, 0.3);
}

.brush-preview-caption,
.brush-field-label {
  color: rgba(55, 65, 81, 0.88);
}

:global(body.body--dark) .brush-preview-caption,
:global(body.body--dark) .brush-field-label {
  color: rgba(228, 228, 231, 0.88);
}

.brush-settings-fields {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
}

.brush-color-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.brush-color-input {
  width: 100%;
  height: 44px;
  border: 1px solid rgba(17, 24, 39, 0.14);
  border-radius: 12px;
  overflow: hidden;
  background: #fff;
}

:global(body.body--dark) .brush-color-input {
  border-color: rgba(255, 255, 255, 0.12);
  background: rgba(39, 39, 42, 0.95);
}

.brush-color-input input {
  width: 100%;
  height: 100%;
  border: 0;
  padding: 0;
  background: transparent;
  cursor: pointer;
}

@media (max-width: 720px) {
  .brush-settings-panel {
    grid-template-columns: 1fr;
  }
}
</style>
