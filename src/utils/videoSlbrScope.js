export const VIDEO_SLBR_FRAME_SCOPES = Object.freeze({
  FULL: "full",
  MASK: "mask",
  SKIP: "skip",
});

const toFiniteNumber = (value, fallback = 0) => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
};

const isSamVideoTrack = (track) => track?.type === "samVideo";

export const isVideoMaskTrackActiveAtTime = (track, time) => {
  if (!track || track.enabled === false) return false;

  const startTime = toFiniteNumber(track.startTime, 0);
  const endTime = toFiniteNumber(track.endTime, startTime);
  const safeTime = toFiniteNumber(time, 0);
  return safeTime >= startTime && safeTime <= endTime;
};

export const buildVideoSlbrTrackPlan = ({ masks = [], paintedTrackIds = [] } = {}) => {
  const paintedIds = new Set(
    Array.from(paintedTrackIds || [], (id) => String(id || "").trim()).filter(Boolean)
  );
  const enabledTracks = (Array.isArray(masks) ? masks : []).filter(
    (track) => track && track.enabled !== false
  );
  const localTrackIds = [];
  const fullTracks = [];

  enabledTracks.forEach((track) => {
    const trackId = String(track.id || "").trim();
    if (isSamVideoTrack(track) || paintedIds.has(trackId)) {
      localTrackIds.push(trackId);
      return;
    }

    fullTracks.push(track);
  });

  return {
    hasEnabledTracks: enabledTracks.length > 0,
    localTrackIds,
    fullTracks,
  };
};

export const resolveVideoSlbrFrameScope = ({
  trackPlan,
  time,
  localMaskHasPixels = false,
} = {}) => {
  if (!trackPlan?.hasEnabledTracks) {
    return VIDEO_SLBR_FRAME_SCOPES.FULL;
  }

  if (localMaskHasPixels) {
    return VIDEO_SLBR_FRAME_SCOPES.MASK;
  }

  if ((trackPlan.fullTracks || []).some((track) => isVideoMaskTrackActiveAtTime(track, time))) {
    return VIDEO_SLBR_FRAME_SCOPES.FULL;
  }

  return VIDEO_SLBR_FRAME_SCOPES.SKIP;
};
