import maskEraserIconUrl from "src/assets/icons/mask-eraser.svg";
import { DEFAULT_IMAGE_BRUSH, normalizeBrushConfig } from "src/config/ConfigManager";

const MASK_TOOL_MODES = Object.freeze({
  DRAW: "draw",
  RECT: "rect",
  ERASE: "erase",
});

const MASK_TOOL_MODE_VALUES = Object.freeze(Object.values(MASK_TOOL_MODES));

const MASK_TOOL_MODE_OPTIONS = Object.freeze([
  {
    label: "绘制",
    value: MASK_TOOL_MODES.DRAW,
    icon: "brush",
  },
  {
    label: "矩形",
    value: MASK_TOOL_MODES.RECT,
    icon: "crop_square",
  },
  {
    label: "擦除",
    value: MASK_TOOL_MODES.ERASE,
    icon: `img:${maskEraserIconUrl}`,
  },
]);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const normalizeMaskToolMode = (mode) =>
  MASK_TOOL_MODE_VALUES.includes(mode) ? mode : MASK_TOOL_MODES.DRAW;

const normalizeMaskToolState = (tool = {}, defaults = {}) => ({
  drawingEnabled: Boolean(tool.drawingEnabled ?? defaults.drawingEnabled),
  mode: normalizeMaskToolMode(tool.mode ?? defaults.mode),
  brushSize: Math.max(1, Number(tool.brushSize ?? defaults.brushSize ?? 1)),
  brushAlpha: clamp(Number(tool.brushAlpha ?? defaults.brushAlpha ?? 1), 0.05, 1),
  brushColor: tool.brushColor ?? defaults.brushColor ?? "#1976D2",
});

const normalizeMaskToolbarState = (toolbarState = {}) => {
  const manual = Boolean(toolbarState?.manual);
  const x = Number(toolbarState?.position?.x);
  const y = Number(toolbarState?.position?.y);

  return {
    manual,
    position: manual && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null,
  };
};

const createDefaultMaskToolUiState = (brushDefaults = DEFAULT_IMAGE_BRUSH) => {
  const normalizedBrushDefaults = normalizeBrushConfig(brushDefaults, DEFAULT_IMAGE_BRUSH);

  return {
    mode: MASK_TOOL_MODES.DRAW,
    brushSize: normalizedBrushDefaults.size,
    brushAlpha: normalizedBrushDefaults.alpha,
    brushColor: normalizedBrushDefaults.color,
    toolbarState: normalizeMaskToolbarState(),
  };
};

const normalizeMaskToolUiState = (toolState = {}, brushDefaults = DEFAULT_IMAGE_BRUSH) => {
  const normalizedBrushDefaults = normalizeBrushConfig(brushDefaults, DEFAULT_IMAGE_BRUSH);

  return {
    mode: normalizeMaskToolMode(toolState.mode ?? MASK_TOOL_MODES.DRAW),
    brushSize: Math.max(1, Number(toolState.brushSize ?? normalizedBrushDefaults.size)),
    brushAlpha: clamp(Number(toolState.brushAlpha ?? normalizedBrushDefaults.alpha), 0.05, 1),
    brushColor: toolState.brushColor ?? normalizedBrushDefaults.color,
    toolbarState: normalizeMaskToolbarState(toolState.toolbarState),
  };
};

const hexToRgba = (hex, alpha = 1) => {
  const normalized = String(hex || "#ffffff").replace("#", "");
  const safeHex =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : normalized.padEnd(6, "f").slice(0, 6);

  const r = Number.parseInt(safeHex.slice(0, 2), 16);
  const g = Number.parseInt(safeHex.slice(2, 4), 16);
  const b = Number.parseInt(safeHex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${clamp(Number(alpha || 0), 0, 1)})`;
};

const createTransparentMaskDataUrl = (width, height) => {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(width || 1));
  canvas.height = Math.max(1, Math.floor(height || 1));
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
};

export {
  createDefaultMaskToolUiState,
  MASK_TOOL_MODES,
  MASK_TOOL_MODE_OPTIONS,
  MASK_TOOL_MODE_VALUES,
  createTransparentMaskDataUrl,
  hexToRgba,
  normalizeMaskToolMode,
  normalizeMaskToolbarState,
  normalizeMaskToolState,
  normalizeMaskToolUiState,
};
