import { ref } from "vue";

import { MASK_TOOL_MODES, hexToRgba, normalizeMaskToolMode } from "src/utils/maskTool";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const clampPointToCanvas = (point, canvas) => {
  if (!canvas || !point) {
    return null;
  }

  return {
    x: clamp(Number(point.x || 0), 0, canvas.width),
    y: clamp(Number(point.y || 0), 0, canvas.height),
  };
};

const normalizeRect = (startPoint, endPoint, canvas) => {
  const start = clampPointToCanvas(startPoint, canvas);
  const end = clampPointToCanvas(endPoint, canvas);
  if (!start || !end) return null;

  const left = Math.min(start.x, end.x);
  const right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const bottom = Math.max(start.y, end.y);

  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
};

const createDirtyRect = (x, y, width, height) => {
  const left = Math.floor(x);
  const top = Math.floor(y);
  const right = Math.ceil(x + width);
  const bottom = Math.ceil(y + height);

  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
};

const expandDirtyRect = (currentRect, nextRect) => {
  if (!nextRect) return currentRect;
  if (!currentRect) return nextRect;

  const left = Math.min(currentRect.x, nextRect.x);
  const top = Math.min(currentRect.y, nextRect.y);
  const right = Math.max(currentRect.x + currentRect.width, nextRect.x + nextRect.width);
  const bottom = Math.max(currentRect.y + currentRect.height, nextRect.y + nextRect.height);

  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
};

const areImageDataBuffersEqual = (left, right) => {
  if (!left || !right) return false;
  if (left.width !== right.width || left.height !== right.height) return false;
  if (left.data.length !== right.data.length) return false;

  for (let index = 0; index < left.data.length; index += 1) {
    if (left.data[index] !== right.data[index]) {
      return false;
    }
  }

  return true;
};

export const useRasterMaskEditor = ({
  canvasRef,
  ctxRef,
  getTool,
  onPreviewChange,
} = {}) => {
  const isOperating = ref(false);
  const operationMode = ref(MASK_TOOL_MODES.DRAW);
  const operationTool = ref(null);
  const startPoint = ref(null);
  const lastPoint = ref(null);
  const rectPreview = ref(null);
  const snapshotCanvas = ref(null);
  const snapshotCtx = ref(null);
  const operationCanvas = ref(null);
  const operationCtx = ref(null);
  const dirtyRect = ref(null);

  const getCanvas = () => canvasRef?.value || null;
  const getCtx = () => ctxRef?.value || null;

  const ensureSnapshotCanvas = () => {
    const canvas = getCanvas();
    if (!canvas) return null;

    if (!snapshotCanvas.value) {
      snapshotCanvas.value = document.createElement("canvas");
      snapshotCtx.value = snapshotCanvas.value.getContext("2d", {
        willReadFrequently: true,
      });
    }

    if (
      snapshotCanvas.value.width !== canvas.width ||
      snapshotCanvas.value.height !== canvas.height
    ) {
      snapshotCanvas.value.width = canvas.width;
      snapshotCanvas.value.height = canvas.height;
    }

    return snapshotCanvas.value;
  };

  const ensureOperationCanvas = () => {
    const canvas = getCanvas();
    if (!canvas) return null;

    if (!operationCanvas.value) {
      operationCanvas.value = document.createElement("canvas");
      operationCtx.value = operationCanvas.value.getContext("2d", {
        willReadFrequently: true,
      });
    }

    if (
      operationCanvas.value.width !== canvas.width ||
      operationCanvas.value.height !== canvas.height
    ) {
      operationCanvas.value.width = canvas.width;
      operationCanvas.value.height = canvas.height;
    }

    return operationCanvas.value;
  };

  const getNormalizedTool = () => {
    const tool = getTool?.() || {};
    return {
      mode: normalizeMaskToolMode(tool.mode),
      brushColor: tool.brushColor ?? "#1976D2",
      brushAlpha: clamp(Number(tool.brushAlpha ?? 1), 0.05, 1),
      brushSize: Math.max(1, Number(tool.brushSize ?? 1)),
    };
  };

  const snapshotBaseCanvas = () => {
    const canvas = getCanvas();
    const snapshot = ensureSnapshotCanvas();
    if (!canvas || !snapshot || !snapshotCtx.value) return;

    snapshotCtx.value.clearRect(0, 0, snapshot.width, snapshot.height);
    snapshotCtx.value.drawImage(canvas, 0, 0);
  };

  const clearOperationCanvas = () => {
    const operation = ensureOperationCanvas();
    if (!operation || !operationCtx.value) return;
    operationCtx.value.clearRect(0, 0, operation.width, operation.height);
  };

  const clearDirtyRect = () => {
    dirtyRect.value = null;
  };

  const markDirtyRect = (nextDirtyRect) => {
    dirtyRect.value = expandDirtyRect(dirtyRect.value, nextDirtyRect);
    return dirtyRect.value;
  };

  const restoreSnapshotRegion = (region) => {
    const ctx = getCtx();
    if (!ctx || !snapshotCanvas.value || !region) return;

    ctx.clearRect(region.x, region.y, region.width, region.height);
    ctx.drawImage(
      snapshotCanvas.value,
      region.x,
      region.y,
      region.width,
      region.height,
      region.x,
      region.y,
      region.width,
      region.height
    );
  };

  const renderOperationRegion = (region) => {
    const ctx = getCtx();
    const operation = ensureOperationCanvas();
    const activeTool = operationTool.value;
    if (!ctx || !operation || !region || !activeTool) return;

    restoreSnapshotRegion(region);

    ctx.save();
    if (activeTool.mode === MASK_TOOL_MODES.ERASE) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(
        operation,
        region.x,
        region.y,
        region.width,
        region.height,
        region.x,
        region.y,
        region.width,
        region.height
      );
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = activeTool.brushAlpha;
      ctx.drawImage(
        operation,
        region.x,
        region.y,
        region.width,
        region.height,
        region.x,
        region.y,
        region.width,
        region.height
      );
    }
    ctx.restore();
  };

  const getStrokeDirtyRect = (fromPoint, toPoint, brushSize) => {
    if (!fromPoint || !toPoint) return null;

    const padding = Math.ceil(brushSize / 2) + 2;
    const left = Math.min(fromPoint.x, toPoint.x) - padding;
    const top = Math.min(fromPoint.y, toPoint.y) - padding;
    const right = Math.max(fromPoint.x, toPoint.x) + padding;
    const bottom = Math.max(fromPoint.y, toPoint.y) + padding;
    return createDirtyRect(left, top, right - left, bottom - top);
  };

  const drawStrokeSegment = (fromPoint, toPoint) => {
    const operation = ensureOperationCanvas();
    const activeTool = operationTool.value;
    if (!operation || !operationCtx.value || !fromPoint || !toPoint || !activeTool) {
      return;
    }

    operationCtx.value.save();
    operationCtx.value.globalCompositeOperation = "source-over";
    operationCtx.value.strokeStyle = hexToRgba(activeTool.brushColor, 1);
    operationCtx.value.fillStyle = hexToRgba(activeTool.brushColor, 1);
    operationCtx.value.lineWidth = activeTool.brushSize;
    operationCtx.value.lineCap = "round";
    operationCtx.value.lineJoin = "round";
    operationCtx.value.beginPath();
    operationCtx.value.moveTo(fromPoint.x, fromPoint.y);
    operationCtx.value.lineTo(toPoint.x, toPoint.y);
    operationCtx.value.stroke();

    operationCtx.value.beginPath();
    operationCtx.value.arc(toPoint.x, toPoint.y, activeTool.brushSize / 2, 0, Math.PI * 2);
    operationCtx.value.fill();
    operationCtx.value.restore();

    const region = getStrokeDirtyRect(fromPoint, toPoint, activeTool.brushSize);
    markDirtyRect(region);
    renderOperationRegion(region);
    onPreviewChange?.();
  };

  const drawRectPreview = (nextPoint) => {
    const canvas = getCanvas();
    if (!canvas || !startPoint.value) return;

    rectPreview.value = normalizeRect(startPoint.value, nextPoint, canvas);
    onPreviewChange?.();
  };

  const applyRectToCanvas = (rect) => {
    const ctx = getCtx();
    const activeTool = operationTool.value;
    if (!ctx || !rect || !activeTool) return;

    const region = createDirtyRect(rect.x, rect.y, rect.width, rect.height);
    markDirtyRect(region);
    restoreSnapshotRegion(region);

    ctx.save();
    if (activeTool.mode === MASK_TOOL_MODES.ERASE) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0, 0, 0, 1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = hexToRgba(activeTool.brushColor, activeTool.brushAlpha);
    }
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.restore();
  };

  const hasDirtyChanges = () => {
    const canvas = getCanvas();
    const ctx = getCtx();
    if (!canvas || !ctx || !dirtyRect.value || !snapshotCtx.value) {
      return false;
    }

    const { x, y, width, height } = dirtyRect.value;
    const currentImageData = ctx.getImageData(x, y, width, height);
    const originalImageData = snapshotCtx.value.getImageData(x, y, width, height);
    return !areImageDataBuffersEqual(currentImageData, originalImageData);
  };

  const beginOperation = (point) => {
    const canvas = getCanvas();
    const ctx = getCtx();
    if (!canvas || !ctx) {
      return { started: false };
    }

    const clampedPoint = clampPointToCanvas(point, canvas);
    if (!clampedPoint) {
      return { started: false };
    }

    snapshotBaseCanvas();
    clearOperationCanvas();
    clearDirtyRect();

    const tool = getNormalizedTool();
    operationMode.value = tool.mode;
    operationTool.value = tool;
    startPoint.value = clampedPoint;
    lastPoint.value = clampedPoint;
    rectPreview.value = null;
    isOperating.value = true;

    if (tool.mode === MASK_TOOL_MODES.RECT) {
      drawRectPreview(clampedPoint);
    } else {
      drawStrokeSegment(clampedPoint, clampedPoint);
    }

    return {
      started: true,
      point: clampedPoint,
      mode: tool.mode,
    };
  };

  const updateOperation = (point) => {
    if (!isOperating.value) {
      return { updated: false };
    }

    const canvas = getCanvas();
    const clampedPoint = clampPointToCanvas(point, canvas);
    if (!canvas || !clampedPoint) {
      return { updated: false };
    }

    if (operationMode.value === MASK_TOOL_MODES.RECT) {
      drawRectPreview(clampedPoint);
      lastPoint.value = clampedPoint;
      return {
        updated: true,
        point: clampedPoint,
        rect: rectPreview.value,
      };
    }

    drawStrokeSegment(lastPoint.value || clampedPoint, clampedPoint);
    lastPoint.value = clampedPoint;
    return {
      updated: true,
      point: clampedPoint,
    };
  };

  const finishOperation = (point) => {
    if (!isOperating.value) {
      return {
        changed: false,
        rect: null,
        imageData: null,
      };
    }

    if (point) {
      updateOperation(point);
    }

    const finalRect = rectPreview.value;
    if (operationMode.value === MASK_TOOL_MODES.RECT && finalRect) {
      applyRectToCanvas(finalRect);
    }

    const changed = hasDirtyChanges();
    const canvas = getCanvas();
    const ctx = getCtx();
    const currentImageData =
      changed && canvas && ctx ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null;

    isOperating.value = false;
    startPoint.value = null;
    lastPoint.value = null;
    rectPreview.value = null;
    operationMode.value = MASK_TOOL_MODES.DRAW;
    operationTool.value = null;
    clearOperationCanvas();
    clearDirtyRect();

    onPreviewChange?.();

    return {
      changed,
      rect: finalRect,
      imageData: currentImageData,
    };
  };

  const cancelOperation = ({ restore = true } = {}) => {
    if (!isOperating.value) return;

    if (restore && dirtyRect.value) {
      restoreSnapshotRegion(dirtyRect.value);
    }

    clearOperationCanvas();
    clearDirtyRect();
    isOperating.value = false;
    startPoint.value = null;
    lastPoint.value = null;
    rectPreview.value = null;
    operationMode.value = MASK_TOOL_MODES.DRAW;
    operationTool.value = null;
    onPreviewChange?.();
  };

  return {
    isOperating,
    rectPreview,
    beginOperation,
    updateOperation,
    finishOperation,
    cancelOperation,
  };
};
