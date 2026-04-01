import { computed, ref, unref } from "vue";
import { useEventListener } from "@vueuse/core";

import {
  getShortcutTokenFromKeyboardEvent,
  isEditableTarget,
  isExactShortcutMatch,
  isShortcutSubset,
  normalizeShortcutConfig,
  SHORTCUT_DEFINITIONS,
} from "src/utils/shortcutConfig";

export const useConfiguredShortcuts = ({
  enabled = true,
  shortcutConfig,
  createSessionContext,
  onPress,
  onHoldStart,
  onHoldEnd,
} = {}) => {
  const pressedKeys = ref(new Set());
  const activeHoldActionId = ref("");
  const sessionContext = ref(null);
  const triggeredPressActions = ref(new Set());
  const deferredPressActions = ref(new Set());
  const holdConsumedSession = ref(false);

  const normalizedShortcuts = computed(() => normalizeShortcutConfig(unref(shortcutConfig)));
  const pressDefinitions = SHORTCUT_DEFINITIONS.filter((definition) => definition.type === "press");
  const holdDefinitions = SHORTCUT_DEFINITIONS.filter((definition) => definition.type === "hold");

  const isEnabled = () => Boolean(unref(enabled));

  const clearTriggeredPressActions = () => {
    triggeredPressActions.value = new Set();
  };

  const clearDeferredPressActions = () => {
    deferredPressActions.value = new Set();
  };

  const finalizeHoldAction = (event = null) => {
    if (!activeHoldActionId.value) {
      return false;
    }

    const actionId = activeHoldActionId.value;
    activeHoldActionId.value = "";
    onHoldEnd?.(actionId, sessionContext.value, event);
    return true;
  };

  const resetSession = (event = null) => {
    finalizeHoldAction(event);
    pressedKeys.value = new Set();
    sessionContext.value = null;
    holdConsumedSession.value = false;
    clearTriggeredPressActions();
    clearDeferredPressActions();
  };

  const hasPotentialHoldContinuation = (shortcutKeys, shortcuts) =>
    holdDefinitions.some((definition) => {
      const holdKeys = shortcuts[definition.id];
      return (
        Array.isArray(holdKeys) &&
        holdKeys.length > shortcutKeys.length &&
        isShortcutSubset(shortcutKeys, holdKeys)
      );
    });

  const finalizeDeferredPressActions = (currentKeys, event = null) => {
    if (holdConsumedSession.value || deferredPressActions.value.size === 0) {
      return false;
    }

    const shortcuts = normalizedShortcuts.value;
    let handled = false;
    const nextTriggered = new Set(triggeredPressActions.value);

    pressDefinitions.forEach((definition) => {
      if (!deferredPressActions.value.has(definition.id)) {
        return;
      }

      if (!isExactShortcutMatch(currentKeys, shortcuts[definition.id])) {
        return;
      }

      onPress?.(definition.id, sessionContext.value, event);
      nextTriggered.add(definition.id);
      handled = true;
    });

    triggeredPressActions.value = nextTriggered;
    clearDeferredPressActions();
    return handled;
  };

  const syncShortcutState = (event = null) => {
    const shortcuts = normalizedShortcuts.value;
    const currentKeys = pressedKeys.value;
    let handled = false;

    const nextHoldDefinition =
      holdDefinitions.find((definition) =>
        isExactShortcutMatch(currentKeys, shortcuts[definition.id])
      ) || null;

    if (activeHoldActionId.value && activeHoldActionId.value !== nextHoldDefinition?.id) {
      handled = finalizeHoldAction(event) || handled;
    }

    if (nextHoldDefinition && activeHoldActionId.value !== nextHoldDefinition.id) {
      activeHoldActionId.value = nextHoldDefinition.id;
      holdConsumedSession.value = true;
      clearDeferredPressActions();
      onHoldStart?.(nextHoldDefinition.id, sessionContext.value, event);
      handled = true;
    }

    const nextTriggered = new Set();
    const nextDeferred = new Set();

    if (!holdConsumedSession.value) {
      pressDefinitions.forEach((definition) => {
        const matched = isExactShortcutMatch(currentKeys, shortcuts[definition.id]);
        if (!matched) {
          return;
        }

        const shortcutKeys = shortcuts[definition.id];
        if (hasPotentialHoldContinuation(shortcutKeys, shortcuts)) {
          nextDeferred.add(definition.id);
          return;
        }

        nextTriggered.add(definition.id);
        if (!triggeredPressActions.value.has(definition.id)) {
          onPress?.(definition.id, sessionContext.value, event);
          handled = true;
        }
      });
    }

    triggeredPressActions.value = nextTriggered;
    deferredPressActions.value = nextDeferred;
    return handled;
  };

  const handleKeydown = (event) => {
    if (!isEnabled()) {
      return;
    }

    if (isEditableTarget(event.target)) {
      return;
    }

    const token = getShortcutTokenFromKeyboardEvent(event);
    if (!token) {
      return;
    }

    if (pressedKeys.value.size === 0) {
      sessionContext.value = createSessionContext?.() ?? null;
    }

    if (!pressedKeys.value.has(token)) {
      const nextKeys = new Set(pressedKeys.value);
      nextKeys.add(token);
      pressedKeys.value = nextKeys;
    }

    const handled = syncShortcutState(event);
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const handleKeyup = (event) => {
    if (!pressedKeys.value.size) {
      return;
    }

    const token = getShortcutTokenFromKeyboardEvent(event);
    if (!token) {
      return;
    }

    const previousKeys = new Set(pressedKeys.value);
    const handledDeferred = finalizeDeferredPressActions(previousKeys, event);

    if (pressedKeys.value.has(token)) {
      const nextKeys = new Set(pressedKeys.value);
      nextKeys.delete(token);
      pressedKeys.value = nextKeys;
    }

    const handled = syncShortcutState(event) || handledDeferred;
    if (!pressedKeys.value.size) {
      sessionContext.value = null;
      holdConsumedSession.value = false;
      clearTriggeredPressActions();
      clearDeferredPressActions();
    }

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  useEventListener(window, "keydown", handleKeydown, {
    capture: true,
  });
  useEventListener(window, "keyup", handleKeyup, {
    capture: true,
  });
  useEventListener(window, "blur", () => {
    resetSession();
  });

  return {
    pressedKeys,
    activeHoldActionId,
    resetSession,
  };
};
