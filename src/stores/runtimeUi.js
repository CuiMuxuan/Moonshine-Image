import { ref } from "vue";
import { defineStore } from "pinia";

import { DEFAULT_IMAGE_BRUSH } from "src/config/ConfigManager";
import {
  createDefaultMaskToolUiState,
  normalizeMaskToolUiState,
} from "src/utils/maskTool";

export const useRuntimeUiStore = defineStore("runtimeUi", () => {
  const imageMaskDrawingEnabled = ref(true);
  const imageMaskToolState = ref(createDefaultMaskToolUiState(DEFAULT_IMAGE_BRUSH));
  const imageMaskToolStateInitialized = ref(false);
  const videoMaskDrawingEnabled = ref(true);

  const setImageMaskDrawingEnabled = (value) => {
    imageMaskDrawingEnabled.value = Boolean(value);
  };

  const ensureImageMaskToolState = (brushDefaults = DEFAULT_IMAGE_BRUSH) => {
    if (imageMaskToolStateInitialized.value) {
      return imageMaskToolState.value;
    }

    imageMaskToolState.value = normalizeMaskToolUiState(
      imageMaskToolState.value,
      brushDefaults
    );
    imageMaskToolStateInitialized.value = true;
    return imageMaskToolState.value;
  };

  const setImageMaskToolState = (state = {}, brushDefaults = DEFAULT_IMAGE_BRUSH) => {
    imageMaskToolState.value = normalizeMaskToolUiState(state, brushDefaults);
    imageMaskToolStateInitialized.value = true;
    return imageMaskToolState.value;
  };

  const patchImageMaskToolState = (patch = {}, brushDefaults = DEFAULT_IMAGE_BRUSH) => {
    const nextState = {
      ...imageMaskToolState.value,
      ...patch,
      toolbarState:
        patch.toolbarState === undefined
          ? imageMaskToolState.value.toolbarState
          : patch.toolbarState,
    };

    return setImageMaskToolState(nextState, brushDefaults);
  };

  const setVideoMaskDrawingEnabled = (value) => {
    videoMaskDrawingEnabled.value = Boolean(value);
  };

  return {
    imageMaskDrawingEnabled,
    imageMaskToolState,
    videoMaskDrawingEnabled,
    ensureImageMaskToolState,
    setImageMaskDrawingEnabled,
    setImageMaskToolState,
    patchImageMaskToolState,
    setVideoMaskDrawingEnabled,
  };
});
