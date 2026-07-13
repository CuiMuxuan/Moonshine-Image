import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  normalizeVideoPreviewTrialSeconds,
  resolveVideoPreviewTrialSelection,
  VIDEO_PREVIEW_TRIAL_DURATIONS,
} from "../src/utils/videoPreviewTrial.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

test("video preview trial accepts the supported global defaults", () => {
  assert.deepEqual(VIDEO_PREVIEW_TRIAL_DURATIONS, [3, 10]);
  assert.equal(normalizeVideoPreviewTrialSeconds(3), 3);
  assert.equal(normalizeVideoPreviewTrialSeconds("10"), 10);
  assert.equal(normalizeVideoPreviewTrialSeconds(6), 3);
  assert.equal(normalizeVideoPreviewTrialSeconds(6, 10), 10);
});

test("video preview trial restores an override only while its global baseline is current", () => {
  assert.equal(
    resolveVideoPreviewTrialSelection({
      configuredValue: 3,
      savedValue: 10,
      savedConfigBaseline: 3,
    }),
    10
  );
  assert.equal(
    resolveVideoPreviewTrialSelection({
      configuredValue: 10,
      savedValue: 3,
      savedConfigBaseline: 3,
    }),
    10
  );
  assert.equal(
    resolveVideoPreviewTrialSelection({ configuredValue: 10, savedValue: 3 }),
    10
  );
});

test("VideoPage synchronizes the global default and records the override baseline", () => {
  const source = fs.readFileSync(path.join(repoRoot, "src/pages/VideoPage.vue"), "utf8");
  const captureStart = source.indexOf("const captureVideoUiState = () => ({");
  const captureEnd = source.indexOf("\n});", captureStart);
  const restoreStart = source.indexOf("const restoreVideoUiState = async");
  const restoreEnd = source.indexOf("\n};", restoreStart);

  assert.ok(captureStart >= 0 && captureEnd > captureStart, "captureVideoUiState must exist");
  assert.ok(restoreStart >= 0 && restoreEnd > restoreStart, "restoreVideoUiState must exist");
  assert.match(source.slice(captureStart, captureEnd), /previewTrialSeconds/);
  assert.match(source.slice(captureStart, captureEnd), /previewTrialConfigBaseline/);
  assert.match(source.slice(restoreStart, restoreEnd), /resolveVideoPreviewTrialSelection/);
  assert.match(source, /const configuredPreviewTrialSeconds = computed\(\(\) =>/);
  assert.match(source, /watch\(\s*configuredPreviewTrialSeconds,/);
  assert.match(
    source,
    /previewTrialSeconds\.value = configuredPreviewTrialSeconds\.value;/
  );
});
