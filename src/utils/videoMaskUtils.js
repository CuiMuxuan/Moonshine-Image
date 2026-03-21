const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

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

export const getMaskKeyframeTransform = (keyframe, fallback = {}) => ({
  x: parseNumeric(keyframe?.x, parseNumeric(fallback?.x, 0)),
  y: parseNumeric(keyframe?.y, parseNumeric(fallback?.y, 0)),
  scale: Math.max(0.05, parseNumeric(keyframe?.scale, parseNumeric(fallback?.scale, 1))),
});

export const getVideoCenterAnchor = (width, height) => ({
  x: parseNumeric(width, 1) / 2,
  y: parseNumeric(height, 1) / 2,
});

export const transformPointAroundAnchor = (point, transform, anchor) => {
  const safeScale = Math.max(0.0001, parseNumeric(transform?.scale, 1));
  return {
    x:
      parseNumeric(anchor?.x, 0) +
      parseNumeric(transform?.x, 0) +
      (parseNumeric(point?.x, 0) - parseNumeric(anchor?.x, 0)) * safeScale,
    y:
      parseNumeric(anchor?.y, 0) +
      parseNumeric(transform?.y, 0) +
      (parseNumeric(point?.y, 0) - parseNumeric(anchor?.y, 0)) * safeScale,
  };
};

export const inverseTransformPointAroundAnchor = (point, transform, anchor) => {
  const safeScale = Math.max(0.0001, parseNumeric(transform?.scale, 1));
  return {
    x:
      parseNumeric(anchor?.x, 0) +
      (parseNumeric(point?.x, 0) - parseNumeric(anchor?.x, 0) - parseNumeric(transform?.x, 0)) /
        safeScale,
    y:
      parseNumeric(anchor?.y, 0) +
      (parseNumeric(point?.y, 0) - parseNumeric(anchor?.y, 0) - parseNumeric(transform?.y, 0)) /
        safeScale,
  };
};

export const getTransformedBoundsRect = (bounds, transform, anchor) => {
  if (!bounds) return null;

  const safeScale = Math.max(0.0001, parseNumeric(transform?.scale, 1));
  const center = transformPointAroundAnchor(
    {
      x: parseNumeric(bounds.centerX, 0),
      y: parseNumeric(bounds.centerY, 0),
    },
    transform,
    anchor
  );
  const width = parseNumeric(bounds.width, 0) * safeScale;
  const height = parseNumeric(bounds.height, 0) * safeScale;

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
    return {
      x: parseNumeric(exact.x, 0),
      y: parseNumeric(exact.y, 0),
      scale: parseNumeric(exact.scale, 1),
      fromKeyframe: exact,
      toKeyframe: exact,
      progress: 1,
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
    return {
      x: parseNumeric(previous.x, 0),
      y: parseNumeric(previous.y, 0),
      scale: parseNumeric(previous.scale, 1),
      fromKeyframe: previous,
      toKeyframe: next,
      progress: 1,
    };
  }

  const rawProgress = clamp(
    (safeTime - parseNumeric(previous.time, 0)) /
      (parseNumeric(next.time, 0) - parseNumeric(previous.time, 0)),
    0,
    1
  );
  const easedProgress =
    mask.interpolation === "ease-in-out"
      ? rawProgress < 0.5
        ? 2 * rawProgress * rawProgress
        : 1 - Math.pow(-2 * rawProgress + 2, 2) / 2
      : rawProgress;

  return {
    x:
      parseNumeric(previous.x, 0) +
      (parseNumeric(next.x, 0) - parseNumeric(previous.x, 0)) * easedProgress,
    y:
      parseNumeric(previous.y, 0) +
      (parseNumeric(next.y, 0) - parseNumeric(previous.y, 0)) * easedProgress,
    scale:
      parseNumeric(previous.scale, 1) +
      (parseNumeric(next.scale, 1) - parseNumeric(previous.scale, 1)) * easedProgress,
    fromKeyframe: previous,
    toKeyframe: next,
    progress: easedProgress,
  };
};
