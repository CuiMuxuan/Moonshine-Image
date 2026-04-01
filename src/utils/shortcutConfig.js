export const SHORTCUT_GROUPS = Object.freeze({
  DRAWING: "drawing",
  IMAGE_TOOLBAR: "imageToolbar",
});

export const SHORTCUT_GROUP_META = Object.freeze({
  [SHORTCUT_GROUPS.DRAWING]: {
    label: "绘制工具区",
    description: "仅在图片页和视频页的绘制工具区成功挂载后生效。",
  },
  [SHORTCUT_GROUPS.IMAGE_TOOLBAR]: {
    label: "图片底部工具栏",
    description: "仅在图片处理页预览成功后生效。",
  },
});

const MODIFIER_KEY_ORDER = Object.freeze(["Ctrl", "Alt", "Shift", "Meta"]);

export const SHORTCUT_DEFINITIONS = Object.freeze([
  {
    id: "drawingUndo",
    group: SHORTCUT_GROUPS.DRAWING,
    label: "撤销绘制",
    description: "撤销当前蒙版的最近一次绘制。",
    keyCount: 2,
    type: "press",
    defaultKeys: ["Ctrl", "Z"],
  },
  {
    id: "drawingResetView",
    group: SHORTCUT_GROUPS.DRAWING,
    label: "重置位置",
    description: "重置当前绘制视图或蒙版位置。",
    keyCount: 2,
    type: "press",
    defaultKeys: ["Ctrl", "X"],
  },
  {
    id: "drawingToggle",
    group: SHORTCUT_GROUPS.DRAWING,
    label: "开关绘制",
    description: "开启或关闭当前绘制模式。",
    keyCount: 2,
    type: "press",
    defaultKeys: ["Ctrl", "Space"],
  },
  {
    id: "drawingBrush",
    group: SHORTCUT_GROUPS.DRAWING,
    label: "常驻画笔",
    description: "切换到画笔工具。",
    keyCount: 1,
    type: "press",
    defaultKeys: ["1"],
  },
  {
    id: "drawingRect",
    group: SHORTCUT_GROUPS.DRAWING,
    label: "常驻矩形",
    description: "切换到矩形工具。",
    keyCount: 1,
    type: "press",
    defaultKeys: ["2"],
  },
  {
    id: "drawingErase",
    group: SHORTCUT_GROUPS.DRAWING,
    label: "常驻橡皮",
    description: "切换到橡皮工具。",
    keyCount: 1,
    type: "press",
    defaultKeys: ["3"],
  },
  {
    id: "drawingHoldBrush",
    group: SHORTCUT_GROUPS.DRAWING,
    label: "临时画笔",
    description: "按住时临时切到画笔，松开后恢复。",
    keyCount: 2,
    type: "hold",
    defaultKeys: ["1", "Q"],
  },
  {
    id: "drawingHoldRect",
    group: SHORTCUT_GROUPS.DRAWING,
    label: "临时矩形",
    description: "按住时临时切到矩形，松开后恢复。",
    keyCount: 2,
    type: "hold",
    defaultKeys: ["2", "Q"],
  },
  {
    id: "drawingHoldErase",
    group: SHORTCUT_GROUPS.DRAWING,
    label: "临时橡皮",
    description: "按住时临时切到橡皮，松开后恢复。",
    keyCount: 2,
    type: "hold",
    defaultKeys: ["3", "E"],
  },
  {
    id: "imageUndoProcessing",
    group: SHORTCUT_GROUPS.IMAGE_TOOLBAR,
    label: "撤销处理",
    description: "撤销当前图片最近一次处理结果。",
    keyCount: 3,
    type: "press",
    defaultKeys: ["Ctrl", "Alt", "Z"],
  },
  {
    id: "imageCompareOriginal",
    group: SHORTCUT_GROUPS.IMAGE_TOOLBAR,
    label: "按住对比原图",
    description: "按住时显示原图，松开后恢复处理结果。",
    keyCount: 3,
    type: "hold",
    defaultKeys: ["Ctrl", "Alt", "X"],
  },
  {
    id: "imageSelectAll",
    group: SHORTCUT_GROUPS.IMAGE_TOOLBAR,
    label: "全选图片",
    description: "全选当前图片列表中的图片。",
    keyCount: 2,
    type: "press",
    defaultKeys: ["Ctrl", "A"],
  },
]);

const SHORTCUT_DEFINITION_MAP = Object.freeze(
  SHORTCUT_DEFINITIONS.reduce((result, definition) => {
    result[definition.id] = definition;
    return result;
  }, {})
);

const SPECIAL_KEY_LABELS = Object.freeze({
  " ": "Space",
  Control: "Ctrl",
  ControlLeft: "Ctrl",
  ControlRight: "Ctrl",
  Alt: "Alt",
  AltLeft: "Alt",
  AltRight: "Alt",
  Shift: "Shift",
  ShiftLeft: "Shift",
  ShiftRight: "Shift",
  Meta: "Meta",
  MetaLeft: "Meta",
  MetaRight: "Meta",
  Escape: "Esc",
  Esc: "Esc",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Space: "Space",
});

const normalizeToken = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";

  if (SPECIAL_KEY_LABELS[raw]) {
    return SPECIAL_KEY_LABELS[raw];
  }

  if (/^Digit\d$/i.test(raw) || /^Numpad\d$/i.test(raw)) {
    return raw.slice(-1);
  }

  if (/^Key[A-Z]$/i.test(raw)) {
    return raw.slice(-1).toUpperCase();
  }

  if (/^F\d{1,2}$/i.test(raw)) {
    return raw.toUpperCase();
  }

  if (raw.length === 1) {
    return raw.toUpperCase();
  }

  return raw;
};

const compareShortcutTokens = (left, right) => {
  const leftModifierIndex = MODIFIER_KEY_ORDER.indexOf(left);
  const rightModifierIndex = MODIFIER_KEY_ORDER.indexOf(right);

  if (leftModifierIndex !== -1 || rightModifierIndex !== -1) {
    if (leftModifierIndex === -1) return 1;
    if (rightModifierIndex === -1) return -1;
    return leftModifierIndex - rightModifierIndex;
  }

  return left.localeCompare(right);
};

export const sortShortcutKeys = (keys = []) => [...keys].sort(compareShortcutTokens);

export const normalizeShortcutKeys = (keys = []) => {
  const uniqueKeys = Array.from(
    new Set(
      (Array.isArray(keys) ? keys : [])
        .map((item) => normalizeToken(item))
        .filter(Boolean)
    )
  );
  return sortShortcutKeys(uniqueKeys);
};

export const getShortcutSignature = (keys = []) => normalizeShortcutKeys(keys).join("+");

export const formatShortcutKeys = (keys = []) => normalizeShortcutKeys(keys).join(" + ");

export const getShortcutDefinition = (actionId) =>
  SHORTCUT_DEFINITION_MAP[actionId] || null;

export const createDefaultShortcuts = () =>
  SHORTCUT_DEFINITIONS.reduce((result, definition) => {
    result[definition.id] = [...definition.defaultKeys];
    return result;
  }, {});

export const normalizeShortcutConfig = (shortcutConfig = {}) => {
  const defaults = createDefaultShortcuts();

  return SHORTCUT_DEFINITIONS.reduce((result, definition) => {
    const candidateKeys =
      shortcutConfig?.[definition.id] ?? defaults[definition.id] ?? definition.defaultKeys;
    const normalizedKeys = normalizeShortcutKeys(candidateKeys);

    result[definition.id] =
      normalizedKeys.length === definition.keyCount
        ? normalizedKeys
        : [...definition.defaultKeys];

    return result;
  }, {});
};

export const validateShortcutConfig = (shortcutConfig = {}) => {
  const errors = [];
  const normalized = normalizeShortcutConfig(shortcutConfig);
  const signatureMap = new Map();

  SHORTCUT_DEFINITIONS.forEach((definition) => {
    const keys = normalizeShortcutKeys(normalized[definition.id]);
    if (keys.length !== definition.keyCount) {
      errors.push(`${definition.label}必须使用 ${definition.keyCount} 个按键。`);
      return;
    }

    const signature = getShortcutSignature(keys);
    const conflictActionId = signatureMap.get(signature);
    if (conflictActionId) {
      const conflictDefinition = getShortcutDefinition(conflictActionId);
      errors.push(
        `${definition.label} 与 ${conflictDefinition?.label || conflictActionId} 快捷键冲突。`
      );
      return;
    }

    signatureMap.set(signature, definition.id);
  });

  return errors;
};

export const getShortcutTokenFromKeyboardEvent = (event) => {
  const normalizedCode = normalizeToken(event?.code);
  if (normalizedCode) {
    return normalizedCode;
  }

  return normalizeToken(event?.key);
};

export const isExactShortcutMatch = (pressedKeys, shortcutKeys = []) => {
  const normalizedPressedKeys = normalizeShortcutKeys(Array.from(pressedKeys || []));
  const normalizedShortcutKeys = normalizeShortcutKeys(shortcutKeys);

  if (normalizedPressedKeys.length !== normalizedShortcutKeys.length) {
    return false;
  }

  return normalizedShortcutKeys.every((key) => normalizedPressedKeys.includes(key));
};

export const isShortcutSubset = (candidateKeys = [], targetKeys = []) => {
  const normalizedCandidateKeys = normalizeShortcutKeys(candidateKeys);
  const normalizedTargetKeys = normalizeShortcutKeys(targetKeys);

  if (normalizedCandidateKeys.length > normalizedTargetKeys.length) {
    return false;
  }

  return normalizedCandidateKeys.every((key) => normalizedTargetKeys.includes(key));
};

export const isEditableTarget = (target) => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tagName = target.tagName;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(tagName)) {
    return true;
  }

  return Boolean(target.closest("[contenteditable='true'], .q-field__native, .q-editor"));
};

export const getShortcutsByGroup = (group) =>
  SHORTCUT_DEFINITIONS.filter((definition) => definition.group === group);
