const assertPixelBuffer = (value, label) => {
  if (!value || typeof value.length !== "number" || value.length % 4 !== 0) {
    throw new TypeError(`${label} must be an RGBA pixel buffer.`);
  }
};

export const mergeEraseMaskPixels = (existingPixels, strokePixels) => {
  assertPixelBuffer(existingPixels, "existingPixels");
  assertPixelBuffer(strokePixels, "strokePixels");
  if (existingPixels.length !== strokePixels.length) {
    throw new RangeError("Erase mask pixel buffers must have matching lengths.");
  }

  const merged = new Uint8ClampedArray(existingPixels);
  for (let index = 0; index < merged.length; index += 4) {
    const sourceAlpha = strokePixels[index + 3];
    if (sourceAlpha <= 0) continue;

    const destinationAlpha = merged[index + 3];
    merged[index] = 0;
    merged[index + 1] = 0;
    merged[index + 2] = 0;
    merged[index + 3] = Math.min(
      255,
      sourceAlpha + Math.round((destinationAlpha * (255 - sourceAlpha)) / 255)
    );
  }
  return merged;
};
