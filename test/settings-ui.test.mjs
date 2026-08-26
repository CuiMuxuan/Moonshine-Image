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
const brushControlsSource = fs.readFileSync(
  path.join(repoRoot, "src/components/common/MaskBrushControls.vue"),
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
  assert.match(settingsSource, /<nav class="settings-sidebar" aria-label="全局设置分类">/);
  assert.match(settingsSource, /<q-tabs[\s\S]*vertical[\s\S]*class="settings-main-tabs"/);
  assert.match(settingsSource, /@media \(max-width: 900px\)[\s\S]*\.q-tab__label\) \{ display: none; \}/);
  assert.match(settingsSource, /<q-tooltip>通用配置<\/q-tooltip>/);
  assert.doesNotMatch(settingsSource, /outside-arrows|mobile-arrows/);
  assert.match(settingsSource, /--settings-text-secondary/);
  assert.match(settingsSource, /class="settings-icon-button"/);
  assert.match(settingsSource, /画笔大小/);
  assert.match(settingsSource, /画笔透明度/);
});

test("brush settings keep previews stable and map sliders to names and values", () => {
  assert.match(brushControlsSource, /class="brush-control-header"[\s\S]*画笔大小[\s\S]*brushSizeLabel/);
  assert.match(brushControlsSource, /class="brush-control-header"[\s\S]*画笔透明度[\s\S]*brushAlphaLabel/);
  assert.match(brushControlsSource, /class="brush-color-field"[\s\S]*画笔颜色[\s\S]*brushColor\.toUpperCase/);
  assert.match(brushControlsSource, /\.brush-preview-surface \{[\s\S]*min-height: 132px/);
  assert.match(settingsSource, /class="brush-default-preview"/);
  assert.match(settingsSource, /const getBrushPreviewStyle = \(key\) =>/);
  assert.match(settingsSource, /Math\.min\(76, Number\(brush\.size\)/);
  assert.match(settingsSource, /\.brush-default-preview \{[^}]*height: 112px/);
  assert.doesNotMatch(settingsSource, /class="brush-dot"/);
});

test("brush icon controls expose accessible names", () => {
  assert.match(brushControlsSource, /:aria-label="drawingEnabled \? '关闭绘制' : '开启绘制'"/);
  assert.match(brushControlsSource, /:aria-label="option\.label"/);
  assert.match(brushControlsSource, /aria-label="画笔设置"/);
  assert.match(brushControlsSource, /aria-label="更多画笔操作"/);
  assert.match(brushControlsSource, /aria-label="撤回"/);
  assert.match(brushControlsSource, /aria-label="清空蒙版"/);
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
