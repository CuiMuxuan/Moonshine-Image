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

const getCanvasImageData = (canvas, ctx) => {
  if (!canvas || !ctx) return null;
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
};

const areImageDatasEqual = (data1, data2) => {
  if (!data1 || !data2) return false;
  if (data1.width !== data2.width || data1.height !== data2.height) return false;

  const source = data1.data;
  const target = data2.data;
  if (source.length !== target.length) return false;

  for (let index = 0; index < source.length; index += 4) {
    if (
      (source[index + 3] > 0 || target[index + 3] > 0) &&
      (source[index] !== target[index] ||
        source[index + 1] !== target[index + 1] ||
        source[index + 2] !== target[index + 2] ||
        source[index + 3] !== target[index + 3])
    ) {
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
  const startPoint = ref(null);
  const lastPoint = ref(null);
  const rectPreview = ref(null);
  const snapshotCanvas = ref(null);
  const snapshotCtx = ref(null);
  const operationCanvas = ref(null);
  const operationCtx = ref(null);

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

  const restoreSnapshot = () => {
    const canvas = getCanvas();
    const ctx = getCtx();
    if (!canvas || !ctx || !snapshotCanvas.value) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(snapshotCanvas.value, 0, 0);
  };

  const renderOperationPreview = () => {
    const ctx = getCtx();
    const operation = ensureOperationCanvas();
    if (!ctx || !operation) return;

    const tool = getNormalizedTool();
    restoreSnapshot();

    ctx.save();
    if (tool.mode === MASK_TOOL_MODES.ERASE) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(operation, 0, 0);
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = tool.brushAlpha;
      ctx.drawImage(operation, 0, 0);
    }
    ctx.restore();
  };

  const drawStrokeSegment = (fromPoint, toPoint) => {
    const operation = ensureOperationCanvas();
    if (!operationCtx.value || !operation || !fromPoint || !toPoint) return;

    const tool = getNormalizedTool();
    operationCtx.value.save();
    if (tool.mode === MASK_TOOL_MODES.ERASE) {
      operationCtx.value.globalCompositeOperation = "source-over";
      operationCtx.value.strokeStyle = "rgba(0, 0, 0, 1)";
      operationCtx.value.fillStyle = "rgba(0, 0, 0, 1)";
    } else {
      operationCtx.value.globalCompositeOperation = "source-over";
      operationCtx.value.strokeStyle = hexToRgba(tool.brushColor, 1);
      operationCtx.value.fillStyle = hexToRgba(tool.brushColor, 1);
    }

    operationCtx.value.lineWidth = tool.brushSize;
    operationCtx.value.lineCap = "round";
    operationCtx.value.lineJoin = "round";
    operationCtx.value.beginPath();
    operationCtx.value.moveTo(fromPoint.x, fromPoint.y);
    operationCtx.value.lineTo(toPoint.x, toPoint.y);
    operationCtx.value.stroke();

    operationCtx.value.beginPath();
    operationCtx.value.arc(toPoint.x, toPoint.y, tool.brushSize / 2, 0, Math.PI * 2);
    operationCtx.value.fill();
    operationCtx.value.restore();
    renderOperationPreview();
    onPreviewChange?.();
  };

  const drawRect = (nextPoint) => {
    const canvas = getCanvas();
    const operation = ensureOperationCanvas();
    if (!canvas || !operation || !operationCtx.value || !startPoint.value) return;

    const rect = normalizeRect(startPoint.value, nextPoint, canvas);
    rectPreview.value = rect;
    clearOperationCanvas();

    if (!rect) {
      renderOperationPreview();
      onPreviewChange?.();
      return;
    }

    const tool = getNormalizedTool();
    operationCtx.value.save();
    if (tool.mode === MASK_TOOL_MODES.ERASE) {
      operationCtx.value.globalCompositeOperation = "source-over";
      operationCtx.value.fillStyle = "rgba(0, 0, 0, 1)";
    } else {
      operationCtx.value.globalCompositeOperation = "source-over";
      operationCtx.value.fillStyle = hexToRgba(tool.brushColor, 1);
    }
    operationCtx.value.fillRect(rect.x, rect.y, rect.width, rect.height);
    operationCtx.value.restore();
    renderOperationPreview();
    onPreviewChange?.();
  };

  const beginOperation = (point) => {
    const canvas = getCanvas();
    const ctx = getCtx();
    if (!canvas || !ctx) {
      return {
        started: false,
      };
    }

    const clampedPoint = clampPointToCanvas(point, canvas);
    if (!clampedPoint) {
      return {
        started: false,
      };
    }

    snapshotBaseCanvas();
    clearOperationCanvas();
    const tool = getNormalizedTool();
    operationMode.value = tool.mode;
    startPoint.value = clampedPoint;
    lastPoint.value = clampedPoint;
    rectPreview.value = null;
    isOperating.value = true;

    if (tool.mode === MASK_TOOL_MODES.RECT) {
      drawRect(clampedPoint);
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
      return {
        updated: false,
      };
    }

    const canvas = getCanvas();
    const clampedPoint = clampPointToCanvas(point, canvas);
    if (!canvas || !clampedPoint) {
      return {
        updated: false,
      };
    }

    if (operationMode.value === MASK_TOOL_MODES.RECT) {
      drawRect(clampedPoint);
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

    const canvas = getCanvas();
    const ctx = getCtx();
    const currentImageData = getCanvasImageData(canvas, ctx);
    const startImageData = getCanvasImageData(snapshotCanvas.value, snapshotCtx.value);
    const changed = !areImageDatasEqual(currentImageData, startImageData);

    isOperating.value = false;
    startPoint.value = null;
    lastPoint.value = null;
    const finalRect = rectPreview.value;
    rectPreview.value = null;
    clearOperationCanvas();

    return {
      changed,
      rect: finalRect,
      imageData: currentImageData,
    };
  };

  const cancelOperation = ({ restore = true } = {}) => {
    if (!isOperating.value) return;

    if (restore) {
      restoreSnapshot();
      onPreviewChange?.();
    }

    clearOperationCanvas();

    isOperating.value = false;
    startPoint.value = null;
    lastPoint.value = null;
    rectPreview.value = null;
  };

  return {
    isOperating,
    rectPreview,
    beginOperation,
    updateOperation,
    finishOperation,
    cancelOperation,
    restoreSnapshot,
  };
};
