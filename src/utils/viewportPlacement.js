const normalizeDimension = (value) => {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
};

const normalizeInset = (value) => {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
};

const normalizeViewport = (viewport) => {
  if (!viewport) return null;

  const width = normalizeDimension(viewport.width);
  const height = normalizeDimension(viewport.height);
  const left = Number.isFinite(Number(viewport.left)) ? Number(viewport.left) : 0;
  const top = Number.isFinite(Number(viewport.top)) ? Number(viewport.top) : 0;

  return {
    ...viewport,
    left,
    top,
    width: Math.max(1, width),
    height: Math.max(1, height),
    centerX:
      Number.isFinite(Number(viewport.centerX))
        ? Number(viewport.centerX)
        : left + Math.max(1, width) / 2,
    centerY:
      Number.isFinite(Number(viewport.centerY))
        ? Number(viewport.centerY)
        : top + Math.max(1, height) / 2,
  };
};

export const resolveViewportRect = ({
  containerWidth = 0,
  containerHeight = 0,
  insets = {},
  respectInsets = true,
} = {}) => {
  const width = normalizeDimension(containerWidth);
  const height = normalizeDimension(containerHeight);
  const leftInset = respectInsets ? normalizeInset(insets.left) : 0;
  const rightInset = respectInsets ? normalizeInset(insets.right) : 0;
  const topInset = respectInsets ? normalizeInset(insets.top) : 0;
  const bottomInset = respectInsets ? normalizeInset(insets.bottom) : 0;

  const safeWidth = Math.max(1, width - leftInset - rightInset);
  const safeHeight = Math.max(1, height - topInset - bottomInset);

  return {
    containerWidth: width,
    containerHeight: height,
    left: leftInset,
    top: topInset,
    right: leftInset + safeWidth,
    bottom: topInset + safeHeight,
    width: safeWidth,
    height: safeHeight,
    centerX: leftInset + safeWidth / 2,
    centerY: topInset + safeHeight / 2,
  };
};

export const computeContainPlacement = ({
  contentWidth = 0,
  contentHeight = 0,
  viewport,
} = {}) => {
  const normalizedViewport = normalizeViewport(viewport);
  const width = Math.max(1, normalizeDimension(contentWidth));
  const height = Math.max(1, normalizeDimension(contentHeight));

  if (!normalizedViewport) return null;

  const scaleX = normalizedViewport.width / width;
  const scaleY = normalizedViewport.height / height;
  const scale = Math.min(scaleX, scaleY);

  return {
    scale,
    x: normalizedViewport.left + (normalizedViewport.width - width * scale) / 2,
    y: normalizedViewport.top + (normalizedViewport.height - height * scale) / 2,
  };
};

export const computeAnchoredPlacement = ({
  boxWidth = 0,
  boxHeight = 0,
  viewport,
  alignX = "center",
  alignY = "bottom",
  margin = 20,
} = {}) => {
  const normalizedViewport = normalizeViewport(viewport);
  const width = normalizeDimension(boxWidth);
  const height = normalizeDimension(boxHeight);
  const safeMargin = normalizeInset(margin);

  if (!normalizedViewport) return null;

  const xMap = {
    left: normalizedViewport.left + safeMargin,
    center: normalizedViewport.centerX - width / 2,
    right: normalizedViewport.left + normalizedViewport.width - width - safeMargin,
  };

  const yMap = {
    top: normalizedViewport.top + safeMargin,
    center: normalizedViewport.centerY - height / 2,
    bottom: normalizedViewport.top + normalizedViewport.height - height - safeMargin,
  };

  return {
    x: xMap[alignX] ?? xMap.center,
    y: yMap[alignY] ?? yMap.bottom,
  };
};

export const clampBoxToViewport = ({
  x = 0,
  y = 0,
  boxWidth = 0,
  boxHeight = 0,
  viewport,
  margin = 20,
} = {}) => {
  const normalizedViewport = normalizeViewport(viewport);
  const width = normalizeDimension(boxWidth);
  const height = normalizeDimension(boxHeight);
  const safeMargin = normalizeInset(margin);

  if (!normalizedViewport) {
    return { x, y };
  }

  const minX = normalizedViewport.left + safeMargin;
  const minY = normalizedViewport.top + safeMargin;
  const maxX = Math.max(
    minX,
    normalizedViewport.left + normalizedViewport.width - width - safeMargin
  );
  const maxY = Math.max(
    minY,
    normalizedViewport.top + normalizedViewport.height - height - safeMargin
  );

  return {
    x: Math.min(maxX, Math.max(minX, x)),
    y: Math.min(maxY, Math.max(minY, y)),
  };
};
