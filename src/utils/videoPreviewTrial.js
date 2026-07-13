export const VIDEO_PREVIEW_TRIAL_DURATIONS = Object.freeze([3, 10]);

export const normalizeVideoPreviewTrialSeconds = (value, fallback = 3) => {
  const numeric = Number(value);
  if (VIDEO_PREVIEW_TRIAL_DURATIONS.includes(numeric)) {
    return numeric;
  }

  const normalizedFallback = Number(fallback);
  return VIDEO_PREVIEW_TRIAL_DURATIONS.includes(normalizedFallback) ? normalizedFallback : 3;
};

export const resolveVideoPreviewTrialSelection = ({
  configuredValue,
  savedValue,
  savedConfigBaseline,
} = {}) => {
  const configured = normalizeVideoPreviewTrialSeconds(configuredValue);
  const saved = Number(savedValue);
  const baseline = Number(savedConfigBaseline);

  if (
    VIDEO_PREVIEW_TRIAL_DURATIONS.includes(saved) &&
    VIDEO_PREVIEW_TRIAL_DURATIONS.includes(baseline) &&
    baseline === configured
  ) {
    return saved;
  }

  return configured;
};
