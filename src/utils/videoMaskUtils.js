const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const MIN_MASK_SCALE = 0.05;
const SAFE_POINT_SCALE = 0.0001;
const SCALE_RATIO_TOLERANCE = 0.0005;

export const MASK_KEYFRAME_TYPES = Object.freeze({
  START: "start",
  USER: "user",
  END: "end",
});

const KEYFRAME_TYPE_ORDER = {
  [MASK_KEYFRAME_TYPES.START]: 0,
  [MASK_KEYFRAME_TYPES.USER]: 1,
  [MASK_KEYFRAME_TYPES.END]: 2,
};

export const sortMaskKeyframes = (keyframes = []) =>
  [...keyframes].sort((a, b) => {
    const timeDiff = Number(a.time || 0) - Number(b.time || 0);
    if (Math.abs(timeDiff) > 0.0005) {
      return timeDiff;
    }

    const typeDiff =
      Number(KEYFRAME_TYPE_ORDER[a.type] ?? 99) -
      Number(KEYFRAME_TYPE_ORDER[b.type] ?? 99);
    if (typeDiff !== 0) {
      return typeDiff;
    }

    return String(a.id || "").localeCompare(String(b.id || ""));
  });

export const isMaskBoundaryKeyframe = (keyframe) =>
  keyframe?.type === MASK_KEYFRAME_TYPES.START || keyframe?.type === MASK_KEYFRAME_TYPES.END;

export const isMaskUserKeyframe = (keyframe) => keyframe?.type === MASK_KEYFRAME_TYPES.USER;

export const formatSeconds = (seconds) => {
  const safe = Math.max(0, Number(seconds || 0));
  const totalMilliseconds = Math.round(safe * 1000);
  const milliseconds = String(totalMilliseconds % 1000).padStart(3, "0");
  const totalSeconds = Math.floor(totalMilliseconds / 1000);
  const secs = String(totalSeconds % 60).padStart(2, "0");
  const minutes = String(Math.floor(totalSeconds / 60) % 60).padStart(2, "0");
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  return `${hours}:${minutes}:${secs}.${milliseconds}`;
};

export const parseNumeric = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clampMaskScale = (value, fallback = 1) =>
  Math.max(MIN_MASK_SCALE, parseNumeric(value, fallback));

const getSafeOriginScale = (value, fallback = 1) =>
  Math.max(SAFE_POINT_SCALE, clampMaskScale(value, fallback));

const getScaleRatio = (scale, originScale) =>
  clampMaskScale(scale, 1) / getSafeOriginScale(originScale, 1);

const getUniformScaleRatioFromAxes = ({
  scaleX,
  scaleY,
  originScaleX = 1,
  originScaleY = 1,
}) =>
  (getScaleRatio(scaleX, originScaleX) + getScaleRatio(scaleY, originScaleY)) / 2;

const areRatiosEquivalent = (left, right, tolerance = SCALE_RATIO_TOLERANCE) =>
  Math.abs(Number(left || 0) - Number(right || 0)) <= tolerance;

export const isMaskKeyframeDeformed = (keyframe, tolerance = SCALE_RATIO_TOLERANCE) => {
  const transform = getMaskKeyframeTransform(keyframe);
  return !areRatiosEquivalent(
    getScaleRatio(transform.scaleX, transform.originScaleX),
    getScaleRatio(transform.scaleY, transform.originScaleY),
    tolerance
  );
};

export const getMaskKeyframeUniformScale = (keyframe) => {
  const transform = getMaskKeyframeTransform(keyframe);
  return getUniformScaleRatioFromAxes(transform);
};

export const getMaskKeyframeTransform = (keyframe, fallback = {}) => {
  const fallbackScaleX = clampMaskScale(fallback?.scaleX, parseNumeric(fallback?.scale, 1));
  const fallbackScaleY = clampMaskScale(fallback?.scaleY, parseNumeric(fallback?.scale, 1));
  const fallbackOriginScaleX = getSafeOriginScale(fallback?.originScaleX, 1);
  const fallbackOriginScaleY = getSafeOriginScale(fallback?.originScaleY, 1);
  const scaleX = clampMaskScale(keyframe?.scaleX, parseNumeric(keyframe?.scale, fallbackScaleX));
  const scaleY = clampMaskScale(keyframe?.scaleY, parseNumeric(keyframe?.scale, fallbackScaleY));
  const originScaleX = getSafeOriginScale(keyframe?.originScaleX, fallbackOriginScaleX);
  const originScaleY = getSafeOriginScale(keyframe?.originScaleY, fallbackOriginScaleY);

  return {
    x: parseNumeric(keyframe?.x, parseNumeric(fallback?.x, 0)),
    y: parseNumeric(keyframe?.y, parseNumeric(fallback?.y, 0)),
    scale: clampMaskScale(keyframe?.scale, getUniformScaleRatioFromAxes({
      scaleX,
      scaleY,
      originScaleX,
      originScaleY,
    })),
    scaleX,
    scaleY,
    originScaleX,
    originScaleY,
  };
};

export const getVideoCenterAnchor = (width, height) => ({
  x: parseNumeric(width, 1) / 2,
  y: parseNumeric(height, 1) / 2,
});

export const getBoundsCenterPoint = (bounds) => ({
  x: parseNumeric(bounds?.centerX, 0),
  y: parseNumeric(bounds?.centerY, 0),
});

export const getMaskBoundsCornerPoint = (bounds, corner = "se") => {
  if (!bounds) {
    return {
      x: 0,
      y: 0,
    };
  }

  const left = parseNumeric(bounds.left, parseNumeric(bounds.x, 0));
  const top = parseNumeric(bounds.top, parseNumeric(bounds.y, 0));
  const width = parseNumeric(bounds.width, 0);
  const height = parseNumeric(bounds.height, 0);
  const right = left + width;
  const bottom = top + height;

  switch (corner) {
    case "nw":
      return { x: left, y: top };
    case "ne":
      return { x: right, y: top };
    case "sw":
      return { x: left, y: bottom };
    default:
      return { x: right, y: bottom };
  }
};

export const transformPointAroundAnchor = (point, transform, anchor) => {
  const safeScaleX = Math.max(
    SAFE_POINT_SCALE,
    parseNumeric(transform?.scaleX, parseNumeric(transform?.scale, 1))
  );
  const safeScaleY = Math.max(
    SAFE_POINT_SCALE,
    parseNumeric(transform?.scaleY, parseNumeric(transform?.scale, 1))
  );
  return {
    x:
      parseNumeric(anchor?.x, 0) +
      parseNumeric(transform?.x, 0) +
      (parseNumeric(point?.x, 0) - parseNumeric(anchor?.x, 0)) * safeScaleX,
    y:
      parseNumeric(anchor?.y, 0) +
      parseNumeric(transform?.y, 0) +
      (parseNumeric(point?.y, 0) - parseNumeric(anchor?.y, 0)) * safeScaleY,
  };
};

export const inverseTransformPointAroundAnchor = (point, transform, anchor) => {
  const safeScaleX = Math.max(
    SAFE_POINT_SCALE,
    parseNumeric(transform?.scaleX, parseNumeric(transform?.scale, 1))
  );
  const safeScaleY = Math.max(
    SAFE_POINT_SCALE,
    parseNumeric(transform?.scaleY, parseNumeric(transform?.scale, 1))
  );
  return {
    x:
      parseNumeric(anchor?.x, 0) +
      (parseNumeric(point?.x, 0) - parseNumeric(anchor?.x, 0) - parseNumeric(transform?.x, 0)) /
        safeScaleX,
    y:
      parseNumeric(anchor?.y, 0) +
      (parseNumeric(point?.y, 0) - parseNumeric(anchor?.y, 0) - parseNumeric(transform?.y, 0)) /
        safeScaleY,
  };
};

export const getRenderedMaskCenter = (bounds, transform, anchor) =>
  transformPointAroundAnchor(getBoundsCenterPoint(bounds), transform, anchor);

export const createMaskTransformFromRenderedCenter = ({
  bounds,
  center,
  scaleX,
  scaleY,
  anchor,
  originScaleX = 1,
  originScaleY = 1,
}) => {
  const safeBoundsCenter = getBoundsCenterPoint(bounds);
  const safeAnchor = {
    x: parseNumeric(anchor?.x, 0),
    y: parseNumeric(anchor?.y, 0),
  };
  const safeScaleX = clampMaskScale(scaleX, 1);
  const safeScaleY = clampMaskScale(scaleY, 1);
  const safeOriginScaleX = getSafeOriginScale(originScaleX, 1);
  const safeOriginScaleY = getSafeOriginScale(originScaleY, 1);

  return {
    x:
      parseNumeric(center?.x, 0) -
      safeAnchor.x -
      (safeBoundsCenter.x - safeAnchor.x) * safeScaleX,
    y:
      parseNumeric(center?.y, 0) -
      safeAnchor.y -
      (safeBoundsCenter.y - safeAnchor.y) * safeScaleY,
    scale: getUniformScaleRatioFromAxes({
      scaleX: safeScaleX,
      scaleY: safeScaleY,
      originScaleX: safeOriginScaleX,
      originScaleY: safeOriginScaleY,
    }),
    scaleX: safeScaleX,
    scaleY: safeScaleY,
    originScaleX: safeOriginScaleX,
    originScaleY: safeOriginScaleY,
  };
};

export const getTransformedBoundsRect = (bounds, transform, anchor) => {
  if (!bounds) return null;

  const safeScaleX = Math.max(
    SAFE_POINT_SCALE,
    parseNumeric(transform?.scaleX, parseNumeric(transform?.scale, 1))
  );
  const safeScaleY = Math.max(
    SAFE_POINT_SCALE,
    parseNumeric(transform?.scaleY, parseNumeric(transform?.scale, 1))
  );
  const center = getRenderedMaskCenter(bounds, transform, anchor);
  const width = parseNumeric(bounds.width, 0) * safeScaleX;
  const height = parseNumeric(bounds.height, 0) * safeScaleY;

  return {
    centerX: center.x,
    centerY: center.y,
    width,
    height,
    left: center.x - width / 2,
    top: center.y - height / 2,
  };
};

export const getMaskBoundsFromImageData = (imageData) => {
  if (!imageData?.data?.length || !imageData.width || !imageData.height) {
    return null;
  }

  const { data, width, height } = imageData;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha <= 0) continue;

      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) {
    return null;
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    centerX: minX + (maxX - minX + 1) / 2,
    centerY: minY + (maxY - minY + 1) / 2,
  };
};

export const loadImageElement = (src) =>
  new Promise((resolve, reject) => {
    if (!src) {
      reject(new Error("Image source is required"));
      return;
    }

    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load image"));
    image.src = src;
  });

export const getMaskBoundsFromDataUrl = async (maskDataUrl) => {
  if (!maskDataUrl) return null;

  const image = await loadImageElement(maskDataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width || 1;
  canvas.height = image.naturalHeight || image.height || 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return getMaskBoundsFromImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
};

export const getInterpolatedMaskTransform = (mask, time) => {
  if (!mask?.keyframes?.length) return null;

  const startTime = parseNumeric(mask.startTime, 0);
  const endTime = parseNumeric(mask.endTime, 0);
  const rawTime = parseNumeric(time, 0);
  if (rawTime < startTime || rawTime > endTime) {
    return null;
  }

  const ordered = sortMaskKeyframes(mask.keyframes);
  const safeTime = clamp(rawTime, startTime, endTime);

  const exact = ordered.find((item) => Math.abs(parseNumeric(item.time, 0) - safeTime) <= 0.0005);
  if (exact) {
    const exactTransform = getMaskKeyframeTransform(exact);
    return {
      ...exactTransform,
      fromKeyframe: exact,
      toKeyframe: exact,
      progress: 1,
      isDeformed: isMaskKeyframeDeformed(exactTransform),
    };
  }

  let previous = ordered[0];
  let next = ordered[ordered.length - 1];

  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index];
    if (parseNumeric(current.time, 0) <= safeTime) {
      previous = current;
    }
    if (parseNumeric(current.time, 0) >= safeTime) {
      next = current;
      break;
    }
  }

  if (!previous || !next) return null;
  if (previous.id === next.id || parseNumeric(previous.time, 0) === parseNumeric(next.time, 0)) {
    const previousTransform = getMaskKeyframeTransform(previous);
    return {
      ...previousTransform,
      fromKeyframe: previous,
      toKeyframe: next,
      progress: 1,
      isDeformed: isMaskKeyframeDeformed(previousTransform),
    };
  }

  const progress = clamp(
    (safeTime - parseNumeric(previous.time, 0)) /
      (parseNumeric(next.time, 0) - parseNumeric(previous.time, 0)),
    0,
    1
  );
  const previousTransform = getMaskKeyframeTransform(previous);
  const nextTransform = getMaskKeyframeTransform(next);
  const scaleX = previousTransform.scaleX + (nextTransform.scaleX - previousTransform.scaleX) * progress;
  const scaleY = previousTransform.scaleY + (nextTransform.scaleY - previousTransform.scaleY) * progress;

  return {
    x: previousTransform.x + (nextTransform.x - previousTransform.x) * progress,
    y: previousTransform.y + (nextTransform.y - previousTransform.y) * progress,
    scale: 1,
    scaleX,
    scaleY,
    originScaleX: scaleX,
    originScaleY: scaleY,
    fromKeyframe: previous,
    toKeyframe: next,
    progress,
    isDeformed: false,
  };
};
