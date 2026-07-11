export const VIDEO_ENCODING_QUALITY_POLICIES = Object.freeze({
  performance: Object.freeze({ preset: "performance", crf: 18 }),
  balanced: Object.freeze({ preset: "balanced", crf: 14 }),
  stable: Object.freeze({ preset: "stable", crf: 10 }),
  highStable: Object.freeze({ preset: "highStable", crf: 6 }),
  nearLossless: Object.freeze({ preset: "nearLossless", crf: 2 }),
});

export const resolveVideoEncodingQualityPolicy = (videoConfig = {}) => {
  const preset = String(videoConfig?.encodingQualityPreset || "performance");
  return VIDEO_ENCODING_QUALITY_POLICIES[preset] || VIDEO_ENCODING_QUALITY_POLICIES.performance;
};
