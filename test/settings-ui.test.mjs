import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const settingsSource = fs.readFileSync(
  path.join(repoRoot, "src/components/global/GlobalSettings.vue"),
  "utf8"
);
const panelSource = fs.readFileSync(
  path.join(repoRoot, "src/components/global/SettingsPanel.vue"),
  "utf8"
);

const panelizedSettingKeys = [
  "backendPort",
  "launchMode",
  "backendProjectPath",
  "modelDir",
  "defaultModel",
  "downloadPath",
  "tempPath",
  "imageFolderName",
  "videoFolderName",
  "imageHistoryLimit",
  "imageWarningSize",
  "stateSaveLimit",
  "videoBatchFrameCount",
  "videoIntermediateFrameStrategy",
  "videoEncodingQuality",
  "videoColorStabilization",
  "videoHistoryLimit",
  "videoBatchRetryCount",
  "videoProxyMaxSide",
  "previewTrialSeconds",
];

test("all twenty formerly bare settings use the shared panel surface", () => {
  panelizedSettingKeys.forEach((key) => {
    assert.match(
      settingsSource,
      new RegExp(`<SettingsPanel\\s+v-bind="settingsHelp\\.${key}"`),
      key
    );
  });

  const modelStart = settingsSource.indexOf('<q-tab-panel name="models"');
  const modelEnd = settingsSource.indexOf('<q-tab-panel name="files"', modelStart);
  assert.ok(modelStart >= 0 && modelEnd > modelStart);
  assert.doesNotMatch(settingsSource.slice(modelStart, modelEnd), /SettingsPanel/);
  assert.match(settingsSource.slice(modelStart, modelEnd), /<model-management-panel/);
});

test("settings help uses one dialog and keeps short help inline", () => {
  assert.equal((settingsSource.match(/data-testid="settings-help-dialog"/g) || []).length, 1);
  ["tempCleanup", "samRenderCache", "videoTemporalEnhancement"].forEach((key) => {
    const start = settingsSource.indexOf(`${key}: createSettingsHelp(`);
    const end = settingsSource.indexOf("),", start);
    assert.ok(start >= 0 && end > start, key);
    assert.match(settingsSource.slice(start, end), /"dialog"/);
  });
  assert.match(settingsSource, /openSettingsHelp\('shortcuts'\)/);

  assert.doesNotMatch(settingsSource, /"tooltip"/);
  assert.doesNotMatch(settingsSource, /activeThemeColorTooltip|setThemeColorTooltip/);
  assert.match(settingsSource, /class="settings-inline-description"[\s\S]*settings-help-theme-/);
});

test("settings panels remain keyboard accessible and theme-aware", () => {
  assert.match(panelSource, /settings-panel-\$\{helpTopic\}/);
  assert.match(panelSource, /settings-help-\$\{helpTopic\}/);
  assert.match(panelSource, /helpMode !== 'dialog' && \(\$slots\.description \|\| description\)/);
  assert.doesNotMatch(panelSource, /<q-tooltip|tooltipVisible/);
  assert.match(panelSource, /min-width:\s*44px/);
  assert.match(settingsSource, /outside-arrows/);
  assert.match(settingsSource, /mobile-arrows/);
  assert.match(settingsSource, /--settings-text-secondary/);
  assert.match(settingsSource, /class="settings-icon-button"/);
  assert.match(settingsSource, /画笔大小/);
  assert.match(settingsSource, /画笔透明度/);
});

test("advanced select settings render only their most specific description", () => {
  assert.match(panelSource, /\$slots\.description \|\| description/);
  assert.match(panelSource, /<slot name="description">\{\{ description \}\}<\/slot>/);

  [
    ["imageProcessingMethod", "getImageProcessingHint"],
    ["imageOutput", "getImageOutputFormatHint"],
    ["videoProcessingEngine", "getVideoProcessingEngineHint"],
    ["videoIntermediateFrameStrategy", "getVideoIntermediateFrameStrategyHint"],
    ["videoEncodingQuality", "getVideoEncodingQualityPresetHint"],
    ["videoColorStabilization", "getVideoInpaintColorStabilizationHint"],
  ].forEach(([key, helper]) => {
    const start = settingsSource.indexOf(`<SettingsPanel v-bind="settingsHelp.${key}"`);
    const end = settingsSource.indexOf("</SettingsPanel>", start);
    assert.ok(start >= 0 && end > start, key);
    const block = settingsSource.slice(start, end);
    assert.match(block, new RegExp(`<template #description>\\{\\{ ${helper}\\(\\) \\}\\}<\\/template>`));
    assert.doesNotMatch(block, /<template #hint>/);
  });

  ["imageSmartSelectionModel", "videoSmartSelectionModel"].forEach((key) => {
    const start = settingsSource.indexOf(`<SettingsPanel v-bind="settingsHelp.${key}"`);
    const end = settingsSource.indexOf("</SettingsPanel>", start);
    assert.ok(start >= 0 && end > start, key);
    assert.doesNotMatch(settingsSource.slice(start, end), /<template #hint>|text-caption text-grey-7 q-mt-xs/);
  });
  assert.doesNotMatch(settingsSource, /getImageSamDefaultHint|getVideoSamDefaultHint|getSamDefaultHint/);
});
