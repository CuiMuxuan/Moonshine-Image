import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (filePath) => fs.readFileSync(filePath, "utf8");

test("production sources do not contain debug console.log calls", () => {
  const productionSources = [
    "src/pages/IndexPage.vue",
    "src/services/ImageProcessingService.js",
    "src/stores/editor.js",
    "src-electron/electron-main.js",
  ];

  for (const filePath of productionSources) {
    assert.doesNotMatch(read(filePath), /console\.log\s*\(/, filePath);
  }
});

test("runtime and verification helpers do not embed developer machine paths", () => {
  const helperSources = [
    "README.md",
    "scripts/build-runtime-win.mjs",
    "scripts/verify_video_temporal_enhancement_3s.py",
    "scripts/upload-hf-v1.2.0-watchdog.local.ps1",
  ];
  const developerPathPattern = /C:\\\\(?:code|Users\\\\cjh02)|C:\/(?:code|Users\/cjh02)/i;

  for (const filePath of helperSources) {
    assert.doesNotMatch(read(filePath), developerPathPattern, filePath);
  }
});
