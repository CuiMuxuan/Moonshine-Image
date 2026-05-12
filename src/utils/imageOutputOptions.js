const IMAGE_OUTPUT_FORMAT_OPTIONS = Object.freeze(["auto", "original", "png", "jpg", "webp"]);
const DEFAULT_IMAGE_OUTPUT_QUALITY = 95;
const MIN_IMAGE_OUTPUT_QUALITY = 1;
const MAX_IMAGE_OUTPUT_QUALITY = 100;

const normalizeImageOutputFormat = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "jpeg") return "jpg";
  return IMAGE_OUTPUT_FORMAT_OPTIONS.includes(normalized) ? normalized : "auto";
};

const validateImageOutputFormat = (value) => {
  const normalized = String(value ?? "auto").trim().toLowerCase();
  const format = normalized === "jpeg" ? "jpg" : normalized;
  if (!format) return "auto";
  if (!IMAGE_OUTPUT_FORMAT_OPTIONS.includes(format)) {
    throw new Error("图片输出格式无效。");
  }
  return format;
};

const parseImageOutputQuality = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return NaN;
  return numeric;
};

const validateImageOutputQuality = (value) => {
  const quality = parseImageOutputQuality(value);
  if (
    !Number.isInteger(quality) ||
    quality < MIN_IMAGE_OUTPUT_QUALITY ||
    quality > MAX_IMAGE_OUTPUT_QUALITY
  ) {
    throw new Error(
      `图片输出质量必须在 ${MIN_IMAGE_OUTPUT_QUALITY}-${MAX_IMAGE_OUTPUT_QUALITY} 范围内。`
    );
  }
  return quality;
};

const buildImageOutputRequestOptions = (config = {}) => {
  const advanced = config.advanced || {};
  return {
    output_format: validateImageOutputFormat(advanced.imageOutputFormat),
    output_quality: validateImageOutputQuality(
      advanced.imageOutputQuality ?? DEFAULT_IMAGE_OUTPUT_QUALITY
    ),
  };
};

export {
  DEFAULT_IMAGE_OUTPUT_QUALITY,
  IMAGE_OUTPUT_FORMAT_OPTIONS,
  MAX_IMAGE_OUTPUT_QUALITY,
  MIN_IMAGE_OUTPUT_QUALITY,
  buildImageOutputRequestOptions,
  normalizeImageOutputFormat,
  validateImageOutputFormat,
  validateImageOutputQuality,
};
