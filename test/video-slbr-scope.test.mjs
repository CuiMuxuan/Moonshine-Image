import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVideoSlbrTrackPlan,
  resolveVideoSlbrFrameScope,
  VIDEO_SLBR_FRAME_SCOPES,
} from "../src/utils/videoSlbrScope.js";

const standardTrack = (id, startTime = 0, endTime = 10) => ({
  id,
  type: "standard",
  enabled: true,
  startTime,
  endTime,
});

test("SLBR without tracks keeps full-frame compatibility", () => {
  const plan = buildVideoSlbrTrackPlan();

  assert.equal(
    resolveVideoSlbrFrameScope({ trackPlan: plan, time: 4, localMaskHasPixels: false }),
    VIDEO_SLBR_FRAME_SCOPES.FULL
  );
});

test("an empty standard track selects full processing only in its active range", () => {
  const plan = buildVideoSlbrTrackPlan({ masks: [standardTrack("full", 2, 5)] });

  assert.equal(
    resolveVideoSlbrFrameScope({ trackPlan: plan, time: 3, localMaskHasPixels: false }),
    VIDEO_SLBR_FRAME_SCOPES.FULL
  );
  assert.equal(
    resolveVideoSlbrFrameScope({ trackPlan: plan, time: 6, localMaskHasPixels: false }),
    VIDEO_SLBR_FRAME_SCOPES.SKIP
  );
});

test("painted standard and SAM tracks use local scope, including over an empty full track", () => {
  const plan = buildVideoSlbrTrackPlan({
    masks: [
      standardTrack("full", 0, 10),
      standardTrack("painted", 0, 10),
      { id: "sam", type: "samVideo", enabled: true, startTime: 0, endTime: 10 },
    ],
    paintedTrackIds: ["painted"],
  });

  assert.deepEqual(plan.localTrackIds, ["painted", "sam"]);
  assert.equal(
    resolveVideoSlbrFrameScope({ trackPlan: plan, time: 4, localMaskHasPixels: true }),
    VIDEO_SLBR_FRAME_SCOPES.MASK
  );
  assert.equal(
    resolveVideoSlbrFrameScope({ trackPlan: plan, time: 4, localMaskHasPixels: false }),
    VIDEO_SLBR_FRAME_SCOPES.FULL
  );
});

test("an empty local or SAM frame skips backend work when no full track is active", () => {
  const plan = buildVideoSlbrTrackPlan({
    masks: [
      standardTrack("painted", 0, 10),
      { id: "sam", type: "samVideo", enabled: true, startTime: 0, endTime: 10 },
    ],
    paintedTrackIds: ["painted"],
  });

  assert.equal(
    resolveVideoSlbrFrameScope({ trackPlan: plan, time: 4, localMaskHasPixels: false }),
    VIDEO_SLBR_FRAME_SCOPES.SKIP
  );
});

test("disabled tracks do not change the default full-frame fallback", () => {
  const plan = buildVideoSlbrTrackPlan({
    masks: [{ ...standardTrack("disabled"), enabled: false }],
    paintedTrackIds: ["disabled"],
  });

  assert.equal(plan.hasEnabledTracks, false);
  assert.equal(
    resolveVideoSlbrFrameScope({ trackPlan: plan, time: 4, localMaskHasPixels: false }),
    VIDEO_SLBR_FRAME_SCOPES.FULL
  );
});
