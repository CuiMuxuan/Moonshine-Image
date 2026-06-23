const resolveSamAutoExpandRadius = ({ bboxWidth, bboxHeight, imageWidth, imageHeight } = {}) => {
  if (!bboxWidth || !bboxHeight || !imageWidth || !imageHeight) return 0;
  const maskLongSide = Math.max(1, Math.max(bboxWidth, bboxHeight));

  if (maskLongSide <= 64) return 4;
  if (maskLongSide <= 160) return 5;
  if (maskLongSide <= 360) return 6;
  if (maskLongSide <= 720) return 8;
  return 10;
};

const normalizeSamExpandRadius = (value, fallback = 0) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.max(0, Math.min(99, Math.round(Number(fallback) || 0)));
  return Math.max(0, Math.min(99, Math.round(numeric)));
};

const inspectSamMaskPixels = (imageData) => {
  const { data, width, height } = imageData;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let fillRed = 255;
  let fillGreen = 214;
  let fillBlue = 64;
  let fillAlpha = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const alpha = data[index + 3];
      if (alpha <= 0) continue;

      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (alpha >= fillAlpha) {
        fillRed = data[index];
        fillGreen = data[index + 1];
        fillBlue = data[index + 2];
        fillAlpha = alpha;
      }
    }
  }

  if (maxX < minX || maxY < minY) return null;
  return {
    bboxWidth: maxX - minX + 1,
    bboxHeight: maxY - minY + 1,
    fillRed,
    fillGreen,
    fillBlue,
    fillAlpha,
  };
};

const dilateBinaryAlphaMask = ({ data, width, height, radius } = {}) => {
  const pixelCount = width * height;
  const source = new Uint8Array(pixelCount);
  const horizontal = new Uint8Array(pixelCount);
  const expanded = new Uint8Array(pixelCount);

  for (let pixel = 0, index = 3; pixel < pixelCount; pixel += 1, index += 4) {
    source[pixel] = data[index] > 0 ? 1 : 0;
  }

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let count = 0;
    const initialRight = Math.min(width - 1, radius);
    for (let x = 0; x <= initialRight; x += 1) {
      count += source[row + x];
    }
    for (let x = 0; x < width; x += 1) {
      horizontal[row + x] = count > 0 ? 1 : 0;
      const removeX = x - radius;
      const addX = x + radius + 1;
      if (removeX >= 0) count -= source[row + removeX];
      if (addX < width) count += source[row + addX];
    }
  }

  for (let x = 0; x < width; x += 1) {
    let count = 0;
    const initialBottom = Math.min(height - 1, radius);
    for (let y = 0; y <= initialBottom; y += 1) {
      count += horizontal[y * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      expanded[y * width + x] = count > 0 ? 1 : 0;
      const removeY = y - radius;
      const addY = y + radius + 1;
      if (removeY >= 0) count -= horizontal[removeY * width + x];
      if (addY < height) count += horizontal[addY * width + x];
    }
  }

  return expanded;
};

const expandSamMaskImageDataForLama = (imageData, { imageWidth, imageHeight, radiusOverride = null } = {}) => {
  if (!imageData?.data || !imageData.width || !imageData.height) {
    return { imageData, expanded: false, radius: 0 };
  }

  const width = imageData.width;
  const height = imageData.height;
  const maskInfo = inspectSamMaskPixels(imageData);
  if (!maskInfo) return { imageData, expanded: false, radius: 0 };

  const autoRadius = resolveSamAutoExpandRadius({
    bboxWidth: maskInfo.bboxWidth,
    bboxHeight: maskInfo.bboxHeight,
    imageWidth: imageWidth || width,
    imageHeight: imageHeight || height,
  });
  const radius =
    radiusOverride == null ? autoRadius : normalizeSamExpandRadius(radiusOverride, autoRadius);
  if (!radius) return { imageData, expanded: false, radius: 0 };

  const expandedMask = dilateBinaryAlphaMask({
    data: imageData.data,
    width,
    height,
    radius,
  });
  const expandedData = new Uint8ClampedArray(imageData.data);
  for (let pixel = 0, index = 0; pixel < expandedMask.length; pixel += 1, index += 4) {
    if (!expandedMask[pixel]) {
      expandedData[index + 3] = 0;
      continue;
    }
    if (imageData.data[index + 3] > 0) continue;
    expandedData[index] = maskInfo.fillRed;
    expandedData[index + 1] = maskInfo.fillGreen;
    expandedData[index + 2] = maskInfo.fillBlue;
    expandedData[index + 3] = maskInfo.fillAlpha;
  }

  return {
    imageData: new ImageData(expandedData, width, height),
    expanded: true,
    radius,
  };
};

export {
  dilateBinaryAlphaMask,
  expandSamMaskImageDataForLama,
  inspectSamMaskPixels,
  normalizeSamExpandRadius,
  resolveSamAutoExpandRadius,
};
